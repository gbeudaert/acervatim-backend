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
    const url = `${TMDB_API_BASE}/search/movie?api_key=${this.requireApiKey()}&query=${encodeURIComponent(query)}&page=${page}`;
    // Le cacheKey EXCLUT l'apiKey — sinon une rotation invaliderait tout le cache. Et il est partagé
    // entre users car TMDB n'a pas d'OAuth user.
    const cacheKey = `tmdb:search:${query}:${page}`;

    const raw = await this.cache.getOrFetch<TmdbSearchResponse>(
      cacheKey,
      SEARCH_CACHE_TTL_SECONDS,
      async () => {
        const res = await this.http.request<TmdbSearchResponse>(url);
        return res.data;
      },
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

  async fetchDetails(id: string, _ctx: AdapterContext): Promise<UnifiedItem> {
    await this.consumeRate();
    const url = `${TMDB_API_BASE}/movie/${encodeURIComponent(id)}?api_key=${this.requireApiKey()}&append_to_response=credits`;
    const cacheKey = `tmdb:movie:${id}`;

    const raw = await this.cache.getOrFetch<TmdbMovieDetails>(
      cacheKey,
      DETAILS_CACHE_TTL_SECONDS,
      async () => {
        const res = await this.http.request<TmdbMovieDetails>(url);
        return res.data;
      },
    );

    return this.mapDetails(raw);
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
