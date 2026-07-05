import {
  BadGatewayException,
  BadRequestException,
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
  DecryptedCredentials,
  OauthCredentialsService,
  OauthProvider,
} from '../oauth.service';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TokenResolverService } from '../token-resolver.service';
import { OAuthFlowProvider } from './flow.types';
import { buildOAuth1Header, OAuth1Credentials } from './oauth1';
import {
  AdapterContext,
  AdapterSearchResult,
  SourceAdapter,
  UnifiedItem,
} from './types';

const DISCOGS_REQUEST_TOKEN_URL = 'https://api.discogs.com/oauth/request_token';
const DISCOGS_ACCESS_TOKEN_URL = 'https://api.discogs.com/oauth/access_token';
const DISCOGS_AUTHORIZE_BASE = 'https://www.discogs.com/oauth/authorize';
const DISCOGS_API_BASE = 'https://api.discogs.com';

const PENDING_TTL_SECONDS = 600;
const SEARCH_CACHE_TTL_SECONDS = 3600;
const DETAILS_CACHE_TTL_SECONDS = 86_400;

const RATE_LIMIT_CAPACITY = 60;
const RATE_LIMIT_REFILL_PER_SEC = 1;

// Bucket PARTAGÉ entre tous les premiums servis en repli (consumer key Acervatim) :
// plafonne le débit sortant total sur le compte Acervatim, pour ne pas se faire
// throttler par Discogs. À calibrer sur la limite réelle du compte Acervatim
// (Discogs : ~60 req/min en authentifié consumer).
const ACERVATIM_RATE_LIMIT_CAPACITY = 60;
const ACERVATIM_RATE_LIMIT_REFILL_PER_SEC = 1;

interface PendingRequestToken {
  userId: string;
  requestTokenSecret: string;
}

interface DiscogsSearchResponse {
  results?: DiscogsSearchResult[];
  pagination?: { page?: number; pages?: number };
}

interface DiscogsSearchResult {
  id?: number;
  type?: string;
  title?: string;
  year?: number | string;
  cover_image?: string;
  thumb?: string;
  uri?: string;
  format?: string[];
  label?: string[];
  country?: string;
}

interface DiscogsReleaseResponse {
  id?: number;
  title?: string;
  year?: number | string;
  released?: string;
  // `anv` = artist name variation (nom tel que credite sur la pochette).
  // `name` peut porter un suffixe de desambiguisation Discogs : "Nirvana (2)".
  artists?: { name?: string; anv?: string; join?: string }[];
  images?: { uri?: string; uri150?: string }[];
  thumb?: string;
  uri?: string;
  notes?: string;
  formats?: { name: string }[];
  labels?: { name: string }[];
  country?: string;
  tracklist?: unknown;
  identifiers?: { type?: string; value?: string; description?: string }[];
}

@Injectable()
export class DiscogsAdapter
  implements SourceAdapter, OAuthFlowProvider, OnModuleInit
{
  readonly source = 'discogs' as const;
  readonly mediaType = 'vinyl' as const;
  readonly provider: OauthProvider = 'discogs';

  private readonly logger = new Logger(DiscogsAdapter.name);
  private consumerKey?: string;
  private consumerSecret?: string;
  private callbackUrl!: string;
  /** Personal access token d'un compte Acervatim, pour le repli premium (images). */
  private acervatimToken?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
    private readonly cache: ApiCacheService,
    private readonly bucket: TokenBucketService,
    private readonly creds: OauthCredentialsService,
    private readonly tokenResolver: TokenResolverService,
  ) {}

  onModuleInit() {
    this.consumerKey = this.config.get<string>('DISCOGS_CONSUMER_KEY');
    this.consumerSecret = this.config.get<string>('DISCOGS_CONSUMER_SECRET');
    this.callbackUrl = this.config.get<string>('DISCOGS_CALLBACK_URL')!;
    this.acervatimToken = this.config.get<string>('DISCOGS_ACERVATIM_TOKEN');
  }

  // ----- OAuthFlowProvider -----

  async start(userId: string): Promise<{ authorizeUrl: string }> {
    const consumer = this.requireConsumer();

    const authHeader = buildOAuth1Header(
      'GET',
      DISCOGS_REQUEST_TOKEN_URL,
      consumer,
      { oauth_callback: this.callbackUrl },
    );

    const res = await this.http.request<string>(DISCOGS_REQUEST_TOKEN_URL, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });

    const params = parseFormResponse(res.data);
    const requestToken = params.get('oauth_token');
    const requestTokenSecret = params.get('oauth_token_secret');
    if (!requestToken || !requestTokenSecret) {
      throw new BadGatewayException('discogs: invalid request_token response');
    }

    await this.cache.set<PendingRequestToken>(
      pendingKey(requestToken),
      { userId, requestTokenSecret },
      PENDING_TTL_SECONDS,
    );

    return {
      authorizeUrl: `${DISCOGS_AUTHORIZE_BASE}?oauth_token=${encodeURIComponent(
        requestToken,
      )}`,
    };
  }

  async callback(query: Record<string, string>): Promise<{ userId: string }> {
    const consumer = this.requireConsumer();
    const oauthToken = query.oauth_token;
    const oauthVerifier = query.oauth_verifier;
    if (!oauthToken || !oauthVerifier) {
      throw new BadRequestException(
        'discogs: oauth_token + oauth_verifier required',
      );
    }

    // Récupère le pending (créé en start). On lit via prisma direct pour pouvoir le supprimer après.
    const pending = await this.loadPending(oauthToken);
    if (!pending) {
      throw new BadRequestException('discogs: invalid or expired oauth flow');
    }

    const authHeader = buildOAuth1Header(
      'POST',
      DISCOGS_ACCESS_TOKEN_URL,
      {
        ...consumer,
        tokenKey: oauthToken,
        tokenSecret: pending.requestTokenSecret,
      },
      { oauth_verifier: oauthVerifier },
    );

    const res = await this.http.request<string>(DISCOGS_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: authHeader },
    });

    const params = parseFormResponse(res.data);
    const accessToken = params.get('oauth_token');
    const accessTokenSecret = params.get('oauth_token_secret');
    if (!accessToken || !accessTokenSecret) {
      throw new BadGatewayException('discogs: invalid access_token response');
    }

    // OAuth 1.0a : pas de refresh, on stocke le tokenSecret dans le champ refresh.
    await this.creds.store(pending.userId, 'discogs', {
      accessToken,
      refreshToken: accessTokenSecret,
      expiresAtMs: 0,
      scopes: [],
    });

    await this.removePending(oauthToken);

    return { userId: pending.userId };
  }

  // ----- SourceAdapter -----

  async search(
    query: string,
    ctx: AdapterContext,
  ): Promise<AdapterSearchResult> {
    return this.runSearch({ q: query }, ctx);
  }

  async searchByBarcode(
    barcode: string,
    ctx: AdapterContext,
  ): Promise<AdapterSearchResult> {
    return this.runSearch({ barcode }, ctx);
  }

  private async runSearch(
    criteria: { q?: string; barcode?: string },
    ctx: AdapterContext,
  ): Promise<AdapterSearchResult> {
    await this.consumeRate(ctx.userId);
    const page = parsePage(ctx.cursor);

    const params = new URLSearchParams({ type: 'release' });
    // Discogs expose un paramètre dédié `barcode=` — bien plus fiable qu'un `q=` sur l'EAN.
    if (criteria.barcode) {
      params.set('barcode', criteria.barcode);
    } else {
      params.set('q', criteria.q ?? '');
    }
    params.set('per_page', String(ctx.limit));
    params.set('page', String(page));

    const url = `${DISCOGS_API_BASE}/database/search?${params.toString()}`;
    const mode = criteria.barcode
      ? `barcode:${criteria.barcode}`
      : `q:${criteria.q}`;
    // Clé de cache partagée (réponse Discogs publique) : pas de userId, pour que le
    // repli premium et le mode dégradé (cache-only) profitent des hits inter-users.
    const cacheKey = `discogs:search:${mode}:${page}:${ctx.limit}`;

    const raw = await this.discogsResolvedGet<DiscogsSearchResponse>(
      url,
      cacheKey,
      SEARCH_CACHE_TTL_SECONDS,
      ctx.userId,
    );

    const items = (raw.results ?? []).map((r) => this.mapSearchResult(r));
    const hasMore =
      raw.pagination?.page !== undefined &&
      raw.pagination?.pages !== undefined &&
      raw.pagination.page < raw.pagination.pages;

    return {
      items,
      nextCursor: hasMore ? String(page + 1) : null,
    };
  }

  async fetchDetails(id: string, ctx: AdapterContext): Promise<UnifiedItem> {
    await this.consumeRate(ctx.userId);
    const cacheKey = `discogs:release:${id}`;
    const raw = await this.discogsResolvedGet<DiscogsReleaseResponse>(
      `${DISCOGS_API_BASE}/releases/${encodeURIComponent(id)}`,
      cacheKey,
      DETAILS_CACHE_TTL_SECONDS,
      ctx.userId,
    );
    return this.mapRelease(raw);
  }

  // ----- Helpers privés -----

  /**
   * GET Discogs avec résolution de jeton (cf. `TokenResolverService`) et mode dégradé.
   *  - jeton user présent → OAuth 1.0a signé avec le token utilisateur ;
   *  - premium sans jeton → repli Acervatim = OAuth 1.0a consumer-only (clé
   *    consumer serveur, données publiques) ;
   *  - sinon (dégradé Q-c) → cache-only, aucun appel sortant ; à défaut de hit,
   *    `SourceTokenRequiredException` (403 actionnable : connecter Discogs ou premium).
   * Le repli consumer-only consomme le quota Discogs d'Acervatim : réservé au premium.
   */
  private async discogsResolvedGet<T>(
    url: string,
    cacheKey: string,
    ttlSeconds: number,
    userId: string,
  ): Promise<T> {
    const resolution = await this.tokenResolver.resolve(userId, 'discogs');

    if (resolution.source === 'none') {
      const cached = await this.cache.get<T>(cacheKey);
      if (cached !== null && cached !== undefined) return cached;
      throw new SourceTokenRequiredException('discogs');
    }

    return this.cache.getOrFetch<T>(cacheKey, ttlSeconds, async () => {
      // Repli premium : consomme le bucket partagé Acervatim (sur cache-miss
      // uniquement — un hit ne tape pas le compte Acervatim).
      if (resolution.source === 'fallback') {
        await this.consumeAcervatimRate();
      }
      return this.discogsFetch<T>(
        url,
        resolution.source === 'user' ? resolution.credentials : null,
      );
    });
  }

  private async discogsFetch<T>(
    url: string,
    userCreds: DecryptedCredentials | null,
  ): Promise<T> {
    // Repli premium (pas de jeton user) avec un personal access token Acervatim :
    // `Authorization: Discogs token=` — authentifié ET renvoie les images (la
    // signature consumer-only, elle, authentifie sans jaquettes). Vérifié via
    // scripts/test-discogs-consumer.ts (T8).
    const authHeader =
      userCreds === null && this.acervatimToken
        ? `Discogs token=${this.acervatimToken}`
        : this.buildSignedHeader(url, userCreds);

    const res = await this.http.request<T>(url, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    return res.data;
  }

  /**
   * En-tête OAuth 1.0a : signé avec le token user si présent, sinon consumer-only
   * (repli premium sans personal token — authentifié mais sans images).
   */
  private buildSignedHeader(
    url: string,
    userCreds: DecryptedCredentials | null,
  ): string {
    const consumer = this.requireConsumer();
    const creds: OAuth1Credentials = userCreds
      ? {
          ...consumer,
          tokenKey: userCreds.accessToken,
          // Stocké dans refreshToken — cf. callback().
          tokenSecret: userCreds.refreshToken,
        }
      : consumer;
    return buildOAuth1Header('GET', stripQuery(url), creds, queryParams(url));
  }

  private async consumeRate(userId: string): Promise<void> {
    const ok = await this.bucket.consume(
      `discogs:${userId}`,
      RATE_LIMIT_CAPACITY,
      RATE_LIMIT_REFILL_PER_SEC,
    );
    if (!ok) {
      throw new HttpException(
        'discogs: rate limit exceeded (60 req/min/user)',
        429,
      );
    }
  }

  /** Bucket partagé des replis Acervatim (tous premiums confondus). */
  private async consumeAcervatimRate(): Promise<void> {
    const ok = await this.bucket.consume(
      `acervatim:${this.source}`,
      ACERVATIM_RATE_LIMIT_CAPACITY,
      ACERVATIM_RATE_LIMIT_REFILL_PER_SEC,
    );
    if (!ok) {
      throw new HttpException(
        'discogs: repli Acervatim rate limited (capacité partagée épuisée)',
        429,
      );
    }
  }

  private mapSearchResult(r: DiscogsSearchResult): UnifiedItem {
    const id = r.id !== undefined ? String(r.id) : '';
    return {
      source: 'discogs',
      sourceId: id,
      mediaType: 'vinyl',
      title: stripArtistFromTitle(r.title),
      creators: extractCreatorsFromTitle(r.title),
      releaseDate: r.year ? `${r.year}-01-01` : undefined,
      coverUrl: r.cover_image ?? r.thumb ?? undefined,
      metadata: {
        format: r.format,
        label: r.label,
        country: r.country,
        uri: r.uri,
      },
      rawData: r,
    };
  }

  private mapRelease(r: DiscogsReleaseResponse): UnifiedItem {
    const id = r.id !== undefined ? String(r.id) : '';
    const cover = r.images?.[0]?.uri ?? r.images?.[0]?.uri150 ?? r.thumb;
    const releaseDate = r.released ?? (r.year ? `${r.year}-01-01` : undefined);
    return {
      source: 'discogs',
      sourceId: id,
      mediaType: 'vinyl',
      title: r.title ?? '',
      creators: (r.artists ?? []).map(cleanArtistName).filter(Boolean),
      releaseDate,
      coverUrl: cover,
      description: r.notes,
      metadata: {
        formats: r.formats?.map((f) => f.name),
        labels: r.labels?.map((l) => l.name),
        country: r.country,
        barcode: extractBarcode(r.identifiers),
        tracklist: r.tracklist,
        uri: r.uri,
      },
      rawData: r,
    };
  }

  private requireConsumer(): OAuth1Credentials {
    if (!this.consumerKey || !this.consumerSecret) {
      this.logger.error(
        'DISCOGS_CONSUMER_KEY / DISCOGS_CONSUMER_SECRET not configured',
      );
      throw new ServiceUnavailableException('discogs: not configured');
    }
    return {
      consumerKey: this.consumerKey,
      consumerSecret: this.consumerSecret,
    };
  }

  private loadPending(
    requestToken: string,
  ): Promise<PendingRequestToken | null> {
    return this.cache.get<PendingRequestToken>(pendingKey(requestToken));
  }

  private removePending(requestToken: string): Promise<void> {
    return this.cache.delete(pendingKey(requestToken));
  }
}

function pendingKey(requestToken: string): string {
  return `oauth-discogs-pending:${requestToken}`;
}

function parseFormResponse(data: unknown): URLSearchParams {
  if (typeof data === 'string') return new URLSearchParams(data);
  // HttpClientService renvoie une string quand content-type != json — Discogs renvoie en form-urlencoded.
  // Sécurité : si data est un objet (parser JSON déclenché par contenttype faux), on retombe sur empty.
  return new URLSearchParams('');
}

function parsePage(cursor: string | undefined): number {
  if (!cursor) return 1;
  const n = Number(cursor);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function queryParams(url: string): Record<string, string> {
  const q = url.indexOf('?');
  if (q === -1) return {};
  const params = new URLSearchParams(url.slice(q + 1));
  const out: Record<string, string> = {};
  params.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function cleanArtistName(a: { name?: string; anv?: string }): string {
  // Prefere le nom credite (anv) si present, sinon le nom canonique.
  // Strip le suffixe de desambiguisation Discogs " (N)" final ("Nirvana (2)").
  const raw = (a.anv && a.anv.trim()) || a.name || '';
  return raw.replace(/\s*\(\d+\)$/, '').trim();
}

function extractBarcode(
  identifiers: DiscogsReleaseResponse['identifiers'],
): string | undefined {
  // Discogs liste les codes-barres dans `identifiers` (type "Barcode"). On normalise
  // en gardant uniquement les digits (les valeurs Discogs contiennent parfois des espaces).
  const found = (identifiers ?? []).find(
    (i) => i.type?.toLowerCase() === 'barcode' && i.value,
  );
  if (!found?.value) return undefined;
  const digits = found.value.replace(/\D/g, '');
  return digits.length > 0 ? digits : undefined;
}

function extractCreatorsFromTitle(title: string | undefined): string[] {
  // Discogs search renvoie les results sous la forme "Artist - Title" — pas d'array artists.
  // Best-effort : split au premier " - ". Le fetchDetails donne le vrai array.
  if (!title) return [];
  const idx = title.indexOf(' - ');
  if (idx === -1) return [];
  return [title.slice(0, idx).trim()].filter(Boolean);
}

function stripArtistFromTitle(title: string | undefined): string {
  // Pendant de extractCreatorsFromTitle : retire le prefixe "Artist - " pour ne
  // garder que le titre. Split au PREMIER " - " (un titre peut en contenir d'autres).
  // Sans separateur, le titre est deja propre → renvoye tel quel.
  if (!title) return '';
  const idx = title.indexOf(' - ');
  if (idx === -1) return title.trim();
  return title.slice(idx + 3).trim();
}
