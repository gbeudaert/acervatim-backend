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
import { BnfService } from '../../common/sources/bnf/bnf.service';
import { BnfAuthor } from '../../common/sources/bnf/bnf.types';
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

// Fields supplémentaires utiles au pivot ISBN→MAL (auteurs pour le match, alternative_titles pour debug).
const MAL_PIVOT_FIELDS = `${MAL_MANGA_FIELDS},alternative_titles`;

// Types MAL considérés comme "manga" pour la consolidation (exclut light_novel, etc.).
const MANGA_MEDIA_TYPES = new Set([
  'manga',
  'manhwa',
  'manhua',
  'one_shot',
  'doujinshi',
]);

const PIVOT_SEARCH_LIMIT = 10;

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
  alternative_titles?: { synonyms?: string[]; en?: string; ja?: string };
}

interface PivotCandidate {
  node: MalMangaNode;
  rank: number;
  authorMatched: boolean;
  typeOk: boolean;
  confidence: number;
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
    private readonly bnf: BnfService,
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

  /**
   * Recherche manga par ISBN (EAN-13). Pivot ISBN → BnF (titre original romaji)
   * → MAL (recherche fuzzy + consolidation auteur/type).
   *
   * Logging volontairement explicite sur le process de pivot : ce qu'on a obtenu
   * de la BnF, ce qu'on a interrogé côté MAL, et ce qu'on a retenu (+ confiance).
   * Cf. docs/interne/CONTEXT_isbn_to_mal.md.
   */
  async searchByBarcode(
    barcode: string,
    ctx: AdapterContext,
  ): Promise<AdapterSearchResult> {
    const isbn = barcode;
    this.logger.log(`pivot: start isbn=${isbn}`);

    const resolution = await this.bnf.resolveByIsbn(isbn);
    if (!resolution.ok) {
      this.logger.warn(
        `pivot: bnf unresolved isbn=${isbn} reason=${resolution.reason} -> no candidate`,
      );
      return { items: [], nextCursor: null };
    }
    const notice = resolution.notice;

    if (!notice.originalTitle) {
      // BnF a la fiche mais pas de titre original → pivot MAL impossible (cf. log BnF).
      this.logger.warn(
        `pivot: bnf_only isbn=${isbn} (pas de titre original) -> pas d'enrichissement MAL`,
      );
      return { items: [], nextCursor: null };
    }

    this.logger.log(
      `pivot: bnf->mal isbn=${isbn} query="${notice.originalTitle}" author="${notice.authors[0]?.surname ?? notice.authors[0]?.full ?? '-'}" edition="${notice.edition ?? '-'}" 454h="${notice.sourceVolumeRange ?? '-'}"`,
    );

    await this.consumeRate(ctx.userId);
    const url = `${MAL_API_BASE}/manga?q=${encodeURIComponent(notice.originalTitle)}&limit=${PIVOT_SEARCH_LIMIT}&fields=${encodeURIComponent(MAL_PIVOT_FIELDS)}`;
    const cacheKey = `mal:pivot:${notice.originalTitle.toLowerCase()}`;

    const raw = await this.cache.getOrFetch<MalSearchResponse>(
      cacheKey,
      SEARCH_CACHE_TTL_SECONDS,
      async () => this.malPublicGet<MalSearchResponse>(url),
    );
    const candidates = (raw.data ?? []).map((d) => d.node);
    this.logger.log(
      `pivot: mal candidates isbn=${isbn} count=${candidates.length} titles=[${candidates
        .slice(0, 5)
        .map((c) => c.title)
        .join(' | ')}]`,
    );

    const chosen = this.choosePivotCandidate(candidates, notice.authors);
    if (!chosen) {
      this.logger.warn(
        `pivot: no MAL candidate matched author/type isbn=${isbn} -> bnf_only`,
      );
      return { items: [], nextCursor: null };
    }

    if (
      chosen.node.status === 'currently_publishing' ||
      chosen.node.num_volumes === 0
    ) {
      this.logger.warn(
        `pivot: MAL serie en cours / comptage indispo isbn=${isbn} mal_id=${chosen.node.id} status=${chosen.node.status} num_volumes=${chosen.node.num_volumes} -> totalCount peu fiable, privilegier l'enumeration BnF`,
      );
    }

    this.logger.log(
      `pivot: retained isbn=${isbn} mal_id=${chosen.node.id} title="${chosen.node.title}" media_type=${chosen.node.media_type} authorMatch=${chosen.authorMatched} typeOk=${chosen.typeOk} confidence=${chosen.confidence.toFixed(2)}`,
    );

    const item = this.mapNode(chosen.node);
    item.metadata = {
      ...item.metadata,
      pivot: {
        isbn,
        confidence: chosen.confidence,
        authorMatched: chosen.authorMatched,
        resolutionPath: 'bnf+mal',
      },
      // Données du tome scanné (à reporter dans le tome créé côté client).
      scannedTome: {
        isbn,
        titleFr: notice.titleFr,
        volume: notice.volume,
        edition: notice.edition,
        publisherFr: notice.publisherFr,
        sourceVolumeRange: notice.sourceVolumeRange,
        // Libellé de correspondance dérivé (ex "Tomes 1, 2, 3"). Présentation —
        // séparé de la note privée userData, à afficher en tête côté app.
        sourceVolumeLabel: volumeRangeLabel(notice.sourceVolumeRange),
      },
    };

    return { items: [item], nextCursor: null };
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

  /**
   * Accès aux données PUBLIQUES MAL via `X-MAL-CLIENT-ID` (sans token OAuth user).
   * Utilisé par le pivot ISBN : la recherche par ISBN ne doit pas exiger que
   * l'utilisateur ait connecté son compte MAL.
   */
  private async malPublicGet<T>(url: string): Promise<T> {
    if (!this.clientId) {
      this.logger.error('MAL_CLIENT_ID not configured — pivot impossible');
      throw new ServiceUnavailableException('mal: not configured');
    }
    const res = await this.http.request<T>(url, {
      method: 'GET',
      headers: { 'X-MAL-CLIENT-ID': this.clientId },
    });
    return res.data;
  }

  /**
   * Consolidation : choisit le meilleur candidat MAL pour les auteurs BnF.
   * Critère d'acceptation : match auteur, OU (type manga ET premier résultat).
   * Sinon → null (on préfère ne rien retenir plutôt qu'un faux positif silencieux).
   */
  private choosePivotCandidate(
    candidates: MalMangaNode[],
    bnfAuthors: BnfAuthor[],
  ): PivotCandidate | null {
    let best: PivotCandidate | null = null;

    candidates.forEach((node, rank) => {
      const typeOk = node.media_type
        ? MANGA_MEDIA_TYPES.has(node.media_type)
        : false;
      const authorMatched = matchesAuthor(bnfAuthors, node.authors);

      let confidence = rank === 0 ? 0.3 : Math.max(0, 0.3 - rank * 0.05);
      if (authorMatched) confidence += 0.5;
      if (typeOk) confidence += 0.2;

      const cand: PivotCandidate = {
        node,
        rank,
        authorMatched,
        typeOk,
        confidence,
      };
      if (!best || cand.confidence > best.confidence) best = cand;
    });

    if (!best) return null;
    // Garde-fou anti faux-positif : exiger un signal fort.
    const b: PivotCandidate = best;
    if (!b.authorMatched && !(b.typeOk && b.rank === 0)) {
      return null;
    }
    return b;
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

/**
 * Libellé de correspondance inter-édition depuis un `454$h` normalisé.
 * "1-3" → "Tomes 1, 2, 3" ; "5" → "Tome 5" ; null → null.
 */
function volumeRangeLabel(range: string | null): string | null {
  if (!range) return null;
  const m = range.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from) {
      const list: number[] = [];
      for (let v = from; v <= to; v++) list.push(v);
      return `Tomes ${list.join(', ')}`;
    }
  }
  return /^\d+$/.test(range) ? `Tome ${range}` : `Tomes ${range}`;
}

/** Normalise un nom : minuscules, sans accents/diacritiques. */
function normName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** Tokens d'un nom (mots ≥ 2 lettres), pour comparer sans tenir compte de l'ordre. */
function nameTokens(s: string | undefined): string[] {
  if (!s) return [];
  return normName(s)
    .split(/[\s,]+/)
    .filter((w) => w.length >= 2);
}

/**
 * Match auteur BnF ↔ MAL : vrai si au moins un token de nom (nom/prénom) est
 * commun. Insensible à la casse, aux accents et à l'ordre nom/prénom — c'est le
 * validateur robuste du pivot (le titre romaji peut matcher par chance, l'auteur
 * confirme). Ex. BnF 700$a "Isayama" ↔ MAL last_name "Isayama".
 */
function matchesAuthor(
  bnfAuthors: BnfAuthor[],
  malAuthors: MalMangaNode['authors'],
): boolean {
  if (!bnfAuthors?.length || !malAuthors?.length) return false;

  const malTokens = new Set(
    malAuthors.flatMap((a) => [
      ...nameTokens(a.node?.first_name),
      ...nameTokens(a.node?.last_name),
    ]),
  );
  if (malTokens.size === 0) return false;

  const bnfTokens = bnfAuthors.flatMap((a) => [
    ...nameTokens(a.surname),
    ...nameTokens(a.given),
    ...nameTokens(a.full),
  ]);

  return bnfTokens.some((t) => malTokens.has(t));
}

function parseOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(cursor);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
