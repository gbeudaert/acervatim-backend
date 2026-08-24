import { InjectQueue } from '@nestjs/bullmq';
import {
  BadGatewayException,
  BadRequestException,
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
import { HttpClientService } from '../../common/http/http-client.service';
import { RedisHealthService } from '../../common/redis/redis-health.service';
import { OauthCredentialsService, OauthProvider } from '../oauth.service';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TokenResolverService } from '../token-resolver.service';
import {
  DISCOGS_FETCH_JOB,
  DISCOGS_QUEUE,
  DiscogsFetchJobData,
} from './discogs.types';
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

// Plafond d'attente d'un appel Discogs via la file (au-delà → BadGateway).
const DISCOGS_WAIT_MS = 15_000;

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
  // En recherche, `format` est un tableau plat qui mêle le nom du format ET ses
  // descriptions ("Vinyl", "LP", "Album", "33 ⅓ RPM") — d'où on dérive la vitesse.
  format?: string[];
  genre?: string[];
  style?: string[];
  label?: string[];
  country?: string;
  // Numéro de catalogue du pressage ("MOVLP2464", "88875174261"). Discriminant le plus
  // fort entre deux pressages d'un même album chez un même label la même année.
  catno?: string;
  // Codes-barres portés par le pressage (souvent formatés : "0 81227 97108 3").
  barcode?: string[];
  // Identifiant du « master » Discogs : commun à TOUS les pressages d'un même album.
  // Permet de regrouper les 20-30 résultats d'une recherche texte en quelques albums.
  master_id?: number;
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
  // `descriptions` porte les qualificatifs du pressage, dont la vitesse ("33 ⅓ RPM").
  formats?: { name: string; descriptions?: string[] }[];
  // Discogs distingue `genres` (large : "Rock") de `styles` (fin : "Grunge").
  genres?: string[];
  styles?: string[];
  labels?: { name: string }[];
  country?: string;
  tracklist?: unknown;
  identifiers?: { type?: string; value?: string; description?: string }[];
}

@Injectable()
export class DiscogsAdapter
  implements SourceAdapter, OAuthFlowProvider, OnModuleInit, OnModuleDestroy
{
  readonly source = 'discogs' as const;
  readonly mediaType = 'vinyl' as const;
  readonly provider: OauthProvider = 'discogs';

  private readonly logger = new Logger(DiscogsAdapter.name);
  private consumerKey?: string;
  private consumerSecret?: string;
  private callbackUrl!: string;
  /**
   * Personal access token d'un compte Acervatim (repli premium avec images). Connu du producteur
   * uniquement pour le fast-fail typé (repli demandé mais aucun credential serveur) ; la signature/
   * l'appel réel se font dans `DiscogsProcessor`.
   */
  private acervatimToken?: string;
  private queueEvents!: QueueEvents;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
    private readonly cache: ApiCacheService,
    private readonly creds: OauthCredentialsService,
    private readonly tokenResolver: TokenResolverService,
    private readonly redisHealth: RedisHealthService,
    @InjectQueue(DISCOGS_QUEUE)
    private readonly queue: Queue<DiscogsFetchJobData, unknown>,
  ) {}

  onModuleInit() {
    this.consumerKey = this.config.get<string>('DISCOGS_CONSUMER_KEY');
    this.consumerSecret = this.config.get<string>('DISCOGS_CONSUMER_SECRET');
    this.callbackUrl = this.config.get<string>('DISCOGS_CALLBACK_URL')!;
    this.acervatimToken = this.config.get<string>('DISCOGS_ACERVATIM_TOKEN');
    this.queueEvents = new QueueEvents(DISCOGS_QUEUE, {
      connection: {
        host: this.config.get<string>('REDIS_HOST', 'localhost'),
        port: this.config.get<number>('REDIS_PORT', 6379),
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents?.close();
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
    // Famille de mesure : on sépare volontairement `q` de `barcode`. Une clé code-barres est
    // très partagée entre utilisateurs (même EAN = même clé), une requête texte l'est peu —
    // c'est cet écart de taux de hit qui pilote la pression réelle sur le quota Discogs (SD1).
    const cacheFamily = criteria.barcode
      ? 'discogs:search:barcode'
      : 'discogs:search:q';

    const raw = await this.discogsResolvedGet<DiscogsSearchResponse>(
      url,
      cacheKey,
      SEARCH_CACHE_TTL_SECONDS,
      ctx.userId,
      cacheFamily,
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
    const cacheKey = `discogs:release:${id}`;
    const raw = await this.discogsResolvedGet<DiscogsReleaseResponse>(
      `${DISCOGS_API_BASE}/releases/${encodeURIComponent(id)}`,
      cacheKey,
      DETAILS_CACHE_TTL_SECONDS,
      ctx.userId,
      'discogs:release',
    );
    return this.mapRelease(raw);
  }

  // ----- Helpers privés -----

  /**
   * GET Discogs via la file `discogs` (throttle sortant global + single-flight sur la clé de cache),
   * avec résolution/signature du jeton **dans le worker** (cf. `DiscogsProcessor`) et mode dégradé
   * côté producteur.
   *  - jeton user présent → OAuth 1.0a signé au token utilisateur (worker) ;
   *  - premium sans jeton → repli Acervatim (`Discogs token=` personal ou signature consumer-only)
   *    (worker) ;
   *  - sinon (dégradé) → cache-only, aucun enqueue ; à défaut de hit, `SourceTokenRequiredException`
   *    (403 actionnable : connecter Discogs ou premium).
   * Clé de cache partagée sur clé publique : un hit d'un autre user est réutilisable sans fuite
   * (données Discogs publiques). Aucun secret ne transite par le cacheKey ni le payload du job.
   */
  private async discogsResolvedGet<T>(
    url: string,
    cacheKey: string,
    ttlSeconds: number,
    userId: string,
    cacheFamily: string,
  ): Promise<T> {
    const resolution = await this.tokenResolver.resolve(userId, 'discogs');

    if (resolution.source === 'none') {
      const cached = await this.cache.get<T>(cacheKey, cacheFamily);
      if (cached !== null && cached !== undefined) return cached;
      throw new SourceTokenRequiredException('discogs');
    }

    // Fast-fail typé : repli premium demandé mais aucun credential serveur (ni personal token
    // Acervatim, ni consumer key/secret pour la signature consumer-only). Évite d'enfiler un job
    // voué à échouer et préserve le 503 « not configured » attendu.
    if (
      resolution.source === 'fallback' &&
      !this.acervatimToken &&
      (!this.consumerKey || !this.consumerSecret)
    ) {
      this.logger.error(
        'DISCOGS repli premium impossible : aucun credential serveur',
      );
      throw new ServiceUnavailableException('discogs: not configured');
    }

    return this.cache.getOrFetch<T>(
      cacheKey,
      ttlSeconds,
      () => this.enqueueFetch<T>(url, cacheKey, userId),
      cacheFamily,
    );
  }

  /**
   * Enfile un GET Discogs et attend le worker. Single-flight sur la clé de cache publique (hashée car
   * BullMQ interdit `:` et les espaces dans un jobId, or la clé en contient). Échec worker (Discogs
   * indispo) / Redis / timeout → `BadGatewayException` (pas de mise en cache → re-tentable).
   */
  private async enqueueFetch<T>(
    url: string,
    cacheKey: string,
    userId: string,
  ): Promise<T> {
    // Circuit-breaker : Redis down → 503 immédiat plutôt que d'attendre le timeout de
    // `waitUntilFinished` (~15 s) sur le chemin interactif (cf. RedisHealthService).
    if (!this.redisHealth.isAvailable()) {
      throw new ServiceUnavailableException(
        'discogs: file indisponible (Redis)',
      );
    }
    try {
      const job = await this.queue.add(
        DISCOGS_FETCH_JOB,
        { userId, url },
        {
          jobId: createHash('sha1').update(cacheKey).digest('hex'),
          removeOnComplete: { age: 60, count: 500 },
          removeOnFail: true,
        },
      );
      return (await job.waitUntilFinished(
        this.queueEvents,
        DISCOGS_WAIT_MS,
      )) as T;
    } catch {
      throw new BadGatewayException('discogs: upstream unavailable');
    }
  }

  /**
   * Mappe un résultat de recherche vers `UnifiedItem`. En mode texte, Discogs renvoie couramment
   * 20-30 pressages du même album : la charge utile doit donc porter de quoi **choisir** (SD1).
   * D'où `catno`, `barcodes` et `masterId` dans `metadata`, en plus de l'année / label / pays /
   * format / jaquette. Sans eux, deux pressages voisins sont indiscernables dans la liste.
   */
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
        genres: r.genre,
        styles: r.style,
        recordingSpeed: deriveRecordingSpeed(r.format),
        label: r.label,
        country: r.country,
        // Numéro de catalogue : le discriminant décisif entre deux pressages d'un même
        // album chez un même label la même année (cf. SD1).
        catno: r.catno,
        // Normalisés en digits (Discogs formate : "0 81227 97108 3") pour être comparables
        // à un code-barres scanné et permettre à l'app de repérer un doublon.
        barcodes: normalizeBarcodes(r.barcode),
        // Commun à tous les pressages d'un même album : permet de regrouper la liste.
        masterId: r.master_id !== undefined ? String(r.master_id) : undefined,
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
        genres: r.genres,
        styles: r.styles,
        recordingSpeed: deriveRecordingSpeed(
          releaseFormatDescriptors(r.formats),
        ),
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

function normalizeBarcodes(values: string[] | undefined): string[] | undefined {
  // Discogs formate ses codes-barres de recherche ("0 81227 97108 3", "081227-971083").
  // On ne garde que les digits pour qu'ils soient comparables à un EAN scanné, en
  // dédupliquant (le même code y figure souvent en plusieurs graphies).
  if (!values?.length) return undefined;
  const digits = values
    .map((v) => v.replace(/\D/g, ''))
    .filter((v) => v.length >= 6);
  const unique = [...new Set(digits)];
  return unique.length > 0 ? unique : undefined;
}

function releaseFormatDescriptors(
  formats: DiscogsReleaseResponse['formats'],
): string[] {
  // Aplati nom + descriptions de chaque format pour y chercher la vitesse RPM.
  return (formats ?? [])
    .flatMap((f) => [f.name, ...(f.descriptions ?? [])])
    .filter((s): s is string => Boolean(s));
}

function deriveRecordingSpeed(
  descriptors: string[] | undefined,
): 'RPM_33' | 'RPM_45' | 'RPM_78' | 'OTHER' | undefined {
  // Discogs note la vitesse en clair dans les descriptions ("33 ⅓ RPM", "45 RPM",
  // "78 RPM", parfois "16 ⅔"/"80"). On ne renseigne que si un token RPM est présent —
  // sinon undefined (le média n'est pas un disque à vitesse connue, ex. CD).
  if (!descriptors?.length) return undefined;
  const m = descriptors.join(' ').match(/\b(16|33|45|78|80)\b[^A-Za-z]*RPM\b/i);
  if (!m) return undefined;
  switch (m[1]) {
    case '33':
      return 'RPM_33';
    case '45':
      return 'RPM_45';
    case '78':
      return 'RPM_78';
    default:
      return 'OTHER';
  }
}

function extractCreatorsFromTitle(title: string | undefined): string[] {
  // Discogs search renvoie les results sous la forme "Artist - Title" — pas d'array artists.
  // Best-effort : split au premier " - ". Le fetchDetails donne le vrai array.
  //
  // Deux raffinements (SD1), pour que la liste de résultats texte soit lisible :
  //  - multi-artistes : Discogs les joint par " / " ("Bob Dylan / The Band - Before The Flood")
  //    → on rend un vrai tableau, pas une chaîne unique ;
  //  - suffixe d'homonymie " (N)" ("Nirvana (2)") → strippé, comme dans `cleanArtistName`.
  // Limite assumée : un nom d'artiste contenant lui-même " - " reste indécidable ici ;
  // seul `fetchDetails` (array `artists`) tranche.
  if (!title) return [];
  const idx = title.indexOf(' - ');
  if (idx === -1) return [];
  return title
    .slice(0, idx)
    .split(' / ')
    .map((a) => a.replace(/\s*\(\d+\)$/, '').trim())
    .filter(Boolean);
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
