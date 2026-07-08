import { InjectQueue } from '@nestjs/bullmq';
import {
  BadGatewayException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents } from 'bullmq';
import { createHash } from 'crypto';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { RedisHealthService } from '../../common/redis/redis-health.service';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TokenResolverService } from '../token-resolver.service';
import {
  AdapterContext,
  AdapterSearchResult,
  SourceAdapter,
  UnifiedItem,
} from './types';
import { TMDB_FETCH_JOB, TMDB_QUEUE, TmdbFetchJobData } from './tmdb.types';

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w500';

const SEARCH_CACHE_TTL_SECONDS = 3600;
const DETAILS_CACHE_TTL_SECONDS = 86_400;

// Plafond d'attente d'un appel TMDB via la file (best-effort → BadGateway au-delà).
const TMDB_WAIT_MS = 15_000;

interface TmdbSearchResponse {
  page?: number;
  total_pages?: number;
  results?: TmdbMovieResult[];
}

interface TmdbMovieResult {
  id?: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  vote_average?: number;
  genre_ids?: number[];
}

interface TmdbMovieDetails extends TmdbMovieResult {
  credits?: {
    crew?: { name?: string; job?: string }[];
    cast?: { name?: string }[];
  };
  runtime?: number;
  genres?: { id: number; name: string }[];
}

@Injectable()
export class TmdbAdapter
  implements SourceAdapter, OnModuleInit, OnModuleDestroy
{
  readonly source = 'tmdb' as const;
  readonly mediaType = 'movie' as const;

  private readonly logger = new Logger(TmdbAdapter.name);
  private serverApiKey?: string;
  private queueEvents!: QueueEvents;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: ApiCacheService,
    private readonly tokenResolver: TokenResolverService,
    private readonly redisHealth: RedisHealthService,
    @InjectQueue(TMDB_QUEUE)
    private readonly queue: Queue<TmdbFetchJobData, unknown>,
  ) {}

  onModuleInit() {
    // La clé serveur reste connue de l'adapter uniquement pour le fast-fail typé (repli premium
    // sans clé configurée). L'appel réel et l'injection de clé se font dans TmdbProcessor.
    this.serverApiKey = this.config.get<string>('TMDB_API_KEY');
    this.queueEvents = new QueueEvents(TMDB_QUEUE, {
      connection: {
        host: this.config.get<string>('REDIS_HOST', 'localhost'),
        port: this.config.get<number>('REDIS_PORT', 6379),
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents?.close();
  }

  async search(
    query: string,
    ctx: AdapterContext,
  ): Promise<AdapterSearchResult> {
    const page = parsePage(ctx.cursor);
    // TMDB ignore `limit` côté API (20/page imposé). On respecte donc 20 et on documente.
    // Le cacheKey EXCLUT l'apiKey — sinon une rotation invaliderait tout le cache. Et il est
    // partagé entre users (données TMDB publiques : clé user ou serveur, même réponse).
    const cacheKey = `tmdb:search:${query}:${page}`;
    // URL SANS clé (injectée par le worker).
    const url = `${TMDB_API_BASE}/search/movie?query=${encodeURIComponent(query)}&page=${page}`;

    const raw = await this.tmdbResolvedGet<TmdbSearchResponse>(
      url,
      cacheKey,
      SEARCH_CACHE_TTL_SECONDS,
      ctx.userId,
    );

    const items = (raw.results ?? []).map((r) => this.mapResult(r));
    const hasMore =
      raw.page !== undefined &&
      raw.total_pages !== undefined &&
      raw.page < raw.total_pages;
    return {
      items,
      nextCursor: hasMore ? String(page + 1) : null,
    };
  }

  async fetchDetails(id: string, ctx: AdapterContext): Promise<UnifiedItem> {
    const cacheKey = `tmdb:movie:${id}`;
    const url = `${TMDB_API_BASE}/movie/${encodeURIComponent(id)}?append_to_response=credits`;

    const raw = await this.tmdbResolvedGet<TmdbMovieDetails>(
      url,
      cacheKey,
      DETAILS_CACHE_TTL_SECONDS,
      ctx.userId,
    );

    return this.mapDetails(raw);
  }

  /**
   * GET TMDB via la file `tmdb` (throttle sortant global + single-flight sur la clé de cache), avec
   * résolution de la clé API **dans le worker** (cf. `TmdbProcessor`) et mode dégradé côté producteur.
   *  - clé perso user présente → clé perso (worker) ;
   *  - premium sans clé perso → repli `TMDB_API_KEY` serveur (worker) ;
   *  - sinon (dégradé) → cache-only, aucun enqueue ; à défaut de hit, `SourceTokenRequiredException`.
   * La clé n'apparaît ni dans le cacheKey ni dans le payload du job (jamais en clair dans Redis).
   */
  private async tmdbResolvedGet<T>(
    url: string,
    cacheKey: string,
    ttlSeconds: number,
    userId: string,
  ): Promise<T> {
    const resolution = await this.tokenResolver.resolve(userId, 'tmdb');

    if (resolution.source === 'none') {
      const cached = await this.cache.get<T>(cacheKey);
      if (cached !== null && cached !== undefined) return cached;
      throw new SourceTokenRequiredException('tmdb');
    }

    // Fast-fail typé : repli premium demandé mais clé serveur absente. Évite d'enfiler un job
    // voué à échouer et préserve le 503 « not configured » attendu.
    if (resolution.source === 'fallback' && !this.serverApiKey) {
      this.logger.error('TMDB_API_KEY not configured');
      throw new ServiceUnavailableException('tmdb: not configured');
    }

    return this.cache.getOrFetch<T>(cacheKey, ttlSeconds, async () => {
      // Circuit-breaker : Redis down → 503 immédiat plutôt que d'attendre ~15 s
      // (`waitUntilFinished`) sur le chemin interactif (cf. RedisHealthService).
      if (!this.redisHealth.isAvailable()) {
        throw new ServiceUnavailableException(
          'tmdb: file indisponible (Redis)',
        );
      }
      try {
        const job = await this.queue.add(
          TMDB_FETCH_JOB,
          { userId, url },
          {
            // Single-flight sur la clé publique. Hashée car BullMQ interdit certains caractères
            // (espaces, ':') dans un jobId, et la requête peut en contenir.
            jobId: createHash('sha1').update(cacheKey).digest('hex'),
            removeOnComplete: { age: 60, count: 500 },
            removeOnFail: true,
          },
        );
        return (await job.waitUntilFinished(
          this.queueEvents,
          TMDB_WAIT_MS,
        )) as T;
      } catch {
        // Échec worker (TMDB indispo) / Redis / timeout → 502 (pas de mise en cache).
        throw new BadGatewayException('tmdb: upstream unavailable');
      }
    });
  }

  private mapResult(r: TmdbMovieResult): UnifiedItem {
    const id = r.id !== undefined ? String(r.id) : '';
    return {
      source: 'tmdb',
      sourceId: id,
      mediaType: 'movie',
      title: r.title ?? r.original_title ?? '',
      creators: [],
      releaseDate: r.release_date,
      coverUrl: r.poster_path ? `${TMDB_IMG_BASE}${r.poster_path}` : undefined,
      description: r.overview,
      metadata: {
        original_title: r.original_title,
        vote_average: r.vote_average,
        backdrop_url: r.backdrop_path
          ? `${TMDB_IMG_BASE}${r.backdrop_path}`
          : undefined,
      },
      rawData: r,
    };
  }

  private mapDetails(r: TmdbMovieDetails): UnifiedItem {
    const directors = (r.credits?.crew ?? [])
      .filter((c) => c.job === 'Director')
      .map((c) => c.name ?? '')
      .filter(Boolean);
    const base = this.mapResult(r);
    return {
      ...base,
      creators: directors,
      metadata: {
        ...base.metadata,
        runtime: r.runtime,
        genres: r.genres?.map((g) => g.name),
        cast: r.credits?.cast?.slice(0, 10).map((c) => c.name),
      },
    };
  }
}

function parsePage(cursor: string | undefined): number {
  if (!cursor) return 1;
  const n = Number(cursor);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
