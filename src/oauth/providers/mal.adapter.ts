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
import { randomBytes } from 'crypto';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { HttpClientService } from '../../common/http/http-client.service';
import { TokenBucketService } from '../../common/rate-limit/token-bucket.service';
import { OauthCredentialsService, OauthProvider } from '../oauth.service';
import { OAuthFlowProvider } from './flow.types';
import { codeChallengePlain, generateCodeVerifier } from './pkce';
import {
  AdapterContext,
  AdapterSearchResult,
  SourceAdapter,
  UnifiedItem,
} from './types';

const MAL_AUTHORIZE_URL = 'https://myanimelist.net/v1/oauth2/authorize';
const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
const MAL_API_BASE = 'https://api.myanimelist.net/v2';

const PENDING_TTL_SECONDS = 600;
const SEARCH_CACHE_TTL_SECONDS = 3600;
const DETAILS_CACHE_TTL_SECONDS = 86_400;

const RATE_LIMIT_CAPACITY = 60;
const RATE_LIMIT_REFILL_PER_SEC = 1;

const MAL_MANGA_FIELDS =
  'id,title,main_picture,start_date,synopsis,authors{first_name,last_name},mean,media_type,status,num_volumes';

interface PendingState {
  userId: string;
  codeVerifier: string;
}

interface MalTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface MalSearchResponse {
  data?: { node: MalMangaNode }[];
  paging?: { next?: string; previous?: string };
}

interface MalMangaNode {
  id?: number;
  title?: string;
  main_picture?: { medium?: string; large?: string };
  start_date?: string;
  synopsis?: string;
  authors?: {
    node: { first_name?: string; last_name?: string };
    role?: string;
  }[];
  mean?: number;
  media_type?: string;
  status?: string;
  num_volumes?: number;
}

@Injectable()
export class MalAdapter
  implements SourceAdapter, OAuthFlowProvider, OnModuleInit
{
  readonly source = 'mal' as const;
  readonly mediaType = 'manga' as const;
  readonly provider: OauthProvider = 'mal';

  private readonly logger = new Logger(MalAdapter.name);
  private clientId?: string;
  private clientSecret?: string;
  private callbackUrl!: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
    private readonly cache: ApiCacheService,
    private readonly bucket: TokenBucketService,
    private readonly creds: OauthCredentialsService,
  ) {}

  onModuleInit() {
    this.clientId = this.config.get<string>('MAL_CLIENT_ID');
    this.clientSecret = this.config.get<string>('MAL_CLIENT_SECRET');
    this.callbackUrl = this.config.get<string>('MAL_CALLBACK_URL')!;
  }

  // ----- OAuthFlowProvider -----

  async start(userId: string): Promise<{ authorizeUrl: string }> {
    const { clientId } = this.requireConfig();

    const codeVerifier = generateCodeVerifier();
    // MAL utilise plain : challenge === verifier (cf. pkce.ts).
    const codeChallenge = codeChallengePlain(codeVerifier);
    const state = randomBytes(32).toString('hex');

    await this.cache.set<PendingState>(
      pendingKey(state),
      { userId, codeVerifier },
      PENDING_TTL_SECONDS,
    );

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      code_challenge: codeChallenge,
      code_challenge_method: 'plain',
      state,
      redirect_uri: this.callbackUrl,
    });

    return {
      authorizeUrl: `${MAL_AUTHORIZE_URL}?${params.toString()}`,
    };
  }

  async callback(query: Record<string, string>): Promise<{ userId: string }> {
    const { clientId, clientSecret } = this.requireConfig();
    const code = query.code;
    const state = query.state;
    if (!code || !state) {
      throw new BadRequestException('mal: code + state required');
    }

    const pending = await this.cache.get<PendingState>(pendingKey(state));
    if (!pending) {
      throw new BadRequestException('mal: invalid or expired oauth flow');
    }

    // POST application/x-www-form-urlencoded
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: pending.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: this.callbackUrl,
    }).toString();

    const res = await this.http.request<MalTokenResponse>(MAL_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const token = res.data;
    if (!token.access_token) {
      throw new BadGatewayException('mal: invalid token response');
    }
    const expiresAtMs = token.expires_in
      ? Date.now() + token.expires_in * 1000
      : 0;

    await this.creds.store(pending.userId, 'mal', {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAtMs,
      scopes: [],
    });

    await this.cache.delete(pendingKey(state));

    return { userId: pending.userId };
  }

  // ----- SourceAdapter -----

  async search(
    query: string,
    ctx: AdapterContext,
  ): Promise<AdapterSearchResult> {
    await this.consumeRate(ctx.userId);
    const offset = parseOffset(ctx.cursor);
    const url = `${MAL_API_BASE}/manga?q=${encodeURIComponent(query)}&limit=${ctx.limit}&offset=${offset}&fields=${encodeURIComponent(MAL_MANGA_FIELDS)}`;
    const cacheKey = `mal:search:${ctx.userId}:${query}:${offset}:${ctx.limit}`;

    const raw = await this.cache.getOrFetch<MalSearchResponse>(
      cacheKey,
      SEARCH_CACHE_TTL_SECONDS,
      async () => this.malGet<MalSearchResponse>(url, ctx.userId),
    );

    const items = (raw.data ?? []).map((d) => this.mapNode(d.node));
    const nextCursor = raw.paging?.next ? String(offset + ctx.limit) : null;

    return { items, nextCursor };
  }

  async fetchDetails(id: string, ctx: AdapterContext): Promise<UnifiedItem> {
    await this.consumeRate(ctx.userId);
    const url = `${MAL_API_BASE}/manga/${encodeURIComponent(id)}?fields=${encodeURIComponent(MAL_MANGA_FIELDS)}`;
    const cacheKey = `mal:manga:${id}`;

    const raw = await this.cache.getOrFetch<MalMangaNode>(
      cacheKey,
      DETAILS_CACHE_TTL_SECONDS,
      async () => this.malGet<MalMangaNode>(url, ctx.userId),
    );

    return this.mapNode(raw);
  }

  // ----- Helpers privés -----

  private async malGet<T>(url: string, userId: string): Promise<T> {
    const userCreds = await this.creds.get(userId, 'mal');
    if (!userCreds) {
      throw new BadRequestException(
        'mal: user not connected — call /v1/oauth/mal/start first',
      );
    }
    const res = await this.http.request<T>(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${userCreds.accessToken}` },
    });
    return res.data;
  }

  private async consumeRate(userId: string): Promise<void> {
    const ok = await this.bucket.consume(
      `mal:${userId}`,
      RATE_LIMIT_CAPACITY,
      RATE_LIMIT_REFILL_PER_SEC,
    );
    if (!ok) {
      throw new HttpException(
        'mal: rate limit exceeded (60 req/min/user)',
        429,
      );
    }
  }

  private mapNode(node: MalMangaNode): UnifiedItem {
    const id = node.id !== undefined ? String(node.id) : '';
    const creators = (node.authors ?? [])
      .map((a) =>
        `${a.node?.first_name ?? ''} ${a.node?.last_name ?? ''}`.trim(),
      )
      .filter((s) => s.length > 0);
    return {
      source: 'mal',
      sourceId: id,
      mediaType: 'manga',
      title: node.title ?? '',
      creators,
      releaseDate: node.start_date,
      coverUrl: node.main_picture?.large ?? node.main_picture?.medium,
      description: node.synopsis,
      metadata: {
        mean: node.mean,
        media_type: node.media_type,
        status: node.status,
        num_volumes: node.num_volumes,
      },
      rawData: node,
    };
  }

  private requireConfig(): { clientId: string; clientSecret: string } {
    if (!this.clientId || !this.clientSecret) {
      this.logger.error('MAL_CLIENT_ID / MAL_CLIENT_SECRET not configured');
      throw new ServiceUnavailableException('mal: not configured');
    }
    return { clientId: this.clientId, clientSecret: this.clientSecret };
  }
}

function pendingKey(state: string): string {
  return `oauth-mal-pending:${state}`;
}

function parseOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(cursor);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
