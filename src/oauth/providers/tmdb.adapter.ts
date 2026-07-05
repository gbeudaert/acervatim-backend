import {
  HttpException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { HttpClientService } from '../../common/http/http-client.service';
import { TokenBucketService } from '../../common/rate-limit/token-bucket.service';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TokenResolverService } from '../token-resolver.service';
import {
  AdapterContext,
  AdapterSearchResult,
  SourceAdapter,
  UnifiedItem,
} from './types';

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w500';

const SEARCH_CACHE_TTL_SECONDS = 3600;
const DETAILS_CACHE_TTL_SECONDS = 86_400;

// TMDB autorise ~50 req/s par IP. On garde un bucket global modeste
// (clé partagée car pas d'OAuth user — c'est l'IP du backend qui est limitée).
const RATE_LIMIT_CAPACITY = 200;
const RATE_LIMIT_REFILL_PER_SEC = 20;

// Bucket PARTAGÉ entre tous les premiums servis en repli (TMDB_API_KEY Acervatim) :
// plafonne le débit sortant total sur la clé serveur, distinct du bucket global
// (qui couvre aussi les clés perso). À calibrer sur la limite du compte Acervatim.
const ACERVATIM_RATE_LIMIT_CAPACITY = 200;
const ACERVATIM_RATE_LIMIT_REFILL_PER_SEC = 20;

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
export class TmdbAdapter implements SourceAdapter, OnModuleInit {
  readonly source = 'tmdb' as const;
  readonly mediaType = 'movie' as const;

  private readonly logger = new Logger(TmdbAdapter.name);
  private apiKey?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
    private readonly cache: ApiCacheService,
    private readonly bucket: TokenBucketService,
    private readonly tokenResolver: TokenResolverService,
  ) {}

  onModuleInit() {
    this.apiKey = this.config.get<string>('TMDB_API_KEY');
  }

  async search(
    query: string,
    ctx: AdapterContext,
  ): Promise<AdapterSearchResult> {
    await this.consumeRate();
    const page = parsePage(ctx.cursor);
    // TMDB ignore `limit` côté API (20/page imposé). On respecte donc 20 et on documente.
    // Le cacheKey EXCLUT l'apiKey — sinon une rotation invaliderait tout le cache. Et il est
    // partagé entre users (données TMDB publiques : clé user ou serveur, même réponse).
    const cacheKey = `tmdb:search:${query}:${page}`;

    const raw = await this.tmdbResolvedGet<TmdbSearchResponse>(
      (apiKey) =>
        `${TMDB_API_BASE}/search/movie?api_key=${apiKey}&query=${encodeURIComponent(query)}&page=${page}`,
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
    await this.consumeRate();
    const cacheKey = `tmdb:movie:${id}`;

    const raw = await this.tmdbResolvedGet<TmdbMovieDetails>(
      (apiKey) =>
        `${TMDB_API_BASE}/movie/${encodeURIComponent(id)}?api_key=${apiKey}&append_to_response=credits`,
      cacheKey,
      DETAILS_CACHE_TTL_SECONDS,
      ctx.userId,
    );

    return this.mapDetails(raw);
  }

  /**
   * GET TMDB avec résolution de la clé API (cf. `TokenResolverService`) et mode dégradé.
   *  - clé perso user présente → clé API personnelle (BYOT, saisie via
   *    `PUT /v1/sources/tmdb/token`, stockée chiffrée dans `oauth_credentials`) ;
   *  - premium sans clé perso → repli `TMDB_API_KEY` serveur (Acervatim) ;
   *  - sinon (dégradé Q-c) → cache-only, aucun appel sortant ; à défaut de hit,
   *    `SourceTokenRequiredException` (403 actionnable : saisir sa clé ou premium).
   * La clé n'apparaît jamais dans le cacheKey (partagé, insensible à la rotation).
   */
  private async tmdbResolvedGet<T>(
    buildUrl: (apiKey: string) => string,
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

    const apiKey =
      resolution.source === 'user'
        ? resolution.credentials.accessToken
        : this.requireApiKey();

    return this.cache.getOrFetch<T>(cacheKey, ttlSeconds, async () => {
      // Repli premium : consomme le bucket partagé Acervatim (sur cache-miss
      // uniquement — un hit ne tape pas la clé serveur Acervatim).
      if (resolution.source === 'fallback') {
        await this.consumeAcervatimRate();
      }
      const res = await this.http.request<T>(buildUrl(apiKey));
      return res.data;
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

  private async consumeRate(): Promise<void> {
    const ok = await this.bucket.consume(
      'tmdb:global',
      RATE_LIMIT_CAPACITY,
      RATE_LIMIT_REFILL_PER_SEC,
    );
    if (!ok) {
      throw new HttpException('tmdb: rate limit exceeded', 429);
    }
  }

  /** Bucket partagé des replis Acervatim (clé serveur, tous premiums confondus). */
  private async consumeAcervatimRate(): Promise<void> {
    const ok = await this.bucket.consume(
      `acervatim:${this.source}`,
      ACERVATIM_RATE_LIMIT_CAPACITY,
      ACERVATIM_RATE_LIMIT_REFILL_PER_SEC,
    );
    if (!ok) {
      throw new HttpException(
        'tmdb: repli Acervatim rate limited (capacité partagée épuisée)',
        429,
      );
    }
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      this.logger.error('TMDB_API_KEY not configured');
      throw new ServiceUnavailableException('tmdb: not configured');
    }
    return this.apiKey;
  }
}

function parsePage(cursor: string | undefined): number {
  if (!cursor) return 1;
  const n = Number(cursor);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
