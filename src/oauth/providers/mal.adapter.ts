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
import { createHash, randomBytes } from 'crypto';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { HttpClientService } from '../../common/http/http-client.service';
import { BnfService } from '../../common/sources/bnf/bnf.service';
import { BnfAuthor, BnfNotice } from '../../common/sources/bnf/bnf.types';
import { GoogleBooksCoverService } from '../../common/sources/googlebooks/googlebooks.service';
import {
  matchesAuthor,
  PIVOT_TITLE_STRONG,
  titleSimilarity,
} from '../../common/sources/manga-matching';
import { MangaDexCoverService } from '../../common/sources/mangadex/mangadex.service';
import { MangaDexIdentity } from '../../common/sources/mangadex/mangadex.types';
import { RedisHealthService } from '../../common/redis/redis-health.service';
import { OauthCredentialsService, OauthProvider } from '../oauth.service';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TokenResolverService } from '../token-resolver.service';
import { OAuthFlowProvider } from './flow.types';
import { MAL_FETCH_JOB, MAL_QUEUE, MalFetchJobData } from './mal.types';
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

// Plafond d'attente d'un appel MAL via la file (au-delà → BadGateway ; le pivot dégrade en bnf_only).
const MAL_WAIT_MS = 15_000;

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
  /** Similarité titre requête↔candidat ∈ [0,1] (1 = contenance exacte). */
  titleScore: number;
  confidence: number;
}

@Injectable()
export class MalAdapter
  implements SourceAdapter, OAuthFlowProvider, OnModuleInit, OnModuleDestroy
{
  readonly source = 'mal' as const;
  readonly mediaType = 'manga' as const;
  readonly provider: OauthProvider = 'mal';

  private readonly logger = new Logger(MalAdapter.name);
  private clientId?: string;
  private clientSecret?: string;
  private callbackUrl!: string;
  private queueEvents!: QueueEvents;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
    private readonly cache: ApiCacheService,
    private readonly creds: OauthCredentialsService,
    private readonly bnf: BnfService,
    private readonly tokenResolver: TokenResolverService,
    private readonly googleBooks: GoogleBooksCoverService,
    private readonly mangaDex: MangaDexCoverService,
    private readonly redisHealth: RedisHealthService,
    @InjectQueue(MAL_QUEUE)
    private readonly queue: Queue<MalFetchJobData, unknown>,
  ) {}

  onModuleInit() {
    this.clientId = this.config.get<string>('MAL_CLIENT_ID');
    this.clientSecret = this.config.get<string>('MAL_CLIENT_SECRET');
    this.callbackUrl = this.config.get<string>('MAL_CALLBACK_URL')!;
    this.queueEvents = new QueueEvents(MAL_QUEUE, {
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
    const offset = parseOffset(ctx.cursor);
    const url = `${MAL_API_BASE}/manga?q=${encodeURIComponent(query)}&limit=${ctx.limit}&offset=${offset}&fields=${encodeURIComponent(MAL_MANGA_FIELDS)}`;
    // Clé de cache partagée (réponse MAL publique) : pas de userId, pour que le
    // repli premium et le mode dégradé (cache-only) profitent des hits inter-users.
    const cacheKey = `mal:search:${query}:${offset}:${ctx.limit}`;

    const raw = await this.malResolvedGet<MalSearchResponse>(
      url,
      cacheKey,
      SEARCH_CACHE_TTL_SECONDS,
      ctx.userId,
    );

    const items = (raw.data ?? []).map((d) => this.mapNode(d.node));
    const nextCursor = raw.paging?.next ? String(offset + ctx.limit) : null;

    return { items, nextCursor };
  }

  /**
   * Recherche manga par ISBN (EAN-13). Pivot ISBN → BnF (titre original romaji) → **MangaDex**
   * (identité + méta + synopsis FR + jaquettes + `links.mal`) → **MAL en repli** si MangaDex
   * n'identifie pas. Chemin nominal : on porte le `mal_id` fourni par MangaDex, on N'APPELLE PAS MAL
   * (cf. plan §3). MAL redevient joignable par id direct via `links.mal` (sync bibliothèque).
   *
   * Logging volontairement explicite sur le process de pivot : ce qu'on a obtenu de la BnF, la voie
   * d'identification (mangadex / repli mal / bnf_only) et ce qu'on a retenu (+ confiance).
   * Cf. docs/interne/CONTEXT_isbn_to_mal.md et docs/travail/plan-mangadex-source-principale.md.
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

    // Choix de la requête d'identification :
    //  - titre original (454$t romaji) présent → pont le plus fiable, resolutionPath '…+mangadex' ;
    //  - sinon repli sur le titre FR (identique à l'original pour les graphies latines : Black torch,
    //    One Piece…), resolutionPath '…+mangadex-fr'.
    const useOriginal = !!notice.originalTitle;
    const query = notice.originalTitle ?? notice.titleFr ?? null;
    if (!query) {
      // Ni titre original ni titre FR exploitable → identification impossible (cf. log BnF).
      // On renvoie tout de même la notice BnF (bnf_only) au lieu de rien (backend#2).
      this.logger.warn(
        `pivot: bnf_only isbn=${isbn} (ni titre original ni titre FR) -> pas d'enrichissement`,
      );
      return this.bnfOnlyResult(notice, isbn);
    }

    // Chemin nominal : MangaDex identifie (identité + méta + synopsis FR + jaquettes + links.mal).
    // Best-effort : `null` (MangaDex indispo ou non identifié) → repli MAL. On ne rappelle PAS MAL
    // quand MangaDex a réussi : le mal_id est simplement porté en metadata.
    const identity = await this.mangaDex.identifySeries(query, notice.authors);
    if (identity) {
      this.logger.log(
        `pivot: retained via mangadex isbn=${isbn} mangaId=${identity.mangaId} mal_id=${identity.malId ?? '-'} title="${identity.title}" matchedBy=${identity.matchedBy} confidence=${identity.confidence.toFixed(2)} synopsisFr=${identity.descriptionFr ? 'y' : 'n'}`,
      );
      return {
        items: [this.buildMangaDexItem(identity, notice, isbn, useOriginal)],
        nextCursor: null,
      };
    }
    this.logger.log(`pivot: mangadex no match isbn=${isbn} -> repli MAL`);

    return this.malPivotFallback(notice, isbn, query, useOriginal, ctx);
  }

  /**
   * **Repli MAL** (pivot flou historique) : MangaDex n'a pas identifié le manga. On interroge MAL par
   * recherche floue et on consolide par auteur/type, exactement comme avant l'inversion du pivot.
   *  - titre original (454$t) → validation souple (auteur OU type+rang0), `resolutionPath: 'bnf+mal'` ;
   *  - repli titre FR → on EXIGE le match auteur (anti-homonyme), `resolutionPath: 'bnf+mal-fr'`.
   * Échec du repli (aucun candidat, mode dégradé sans jeton…) → notice BnF seule (`bnf_only`).
   */
  private async malPivotFallback(
    notice: BnfNotice,
    isbn: string,
    query: string,
    useOriginal: boolean,
    ctx: AdapterContext,
  ): Promise<AdapterSearchResult> {
    const requireAuthor = !useOriginal;

    this.logger.log(
      `pivot: bnf->mal isbn=${isbn} query="${query}" via=${useOriginal ? '454$t' : 'titleFr(fallback)'} requireAuthor=${requireAuthor} author="${notice.authors[0]?.surname ?? notice.authors[0]?.full ?? '-'}" edition="${notice.edition ?? '-'}" 454h="${notice.sourceVolumeRange ?? '-'}"`,
    );

    const url = `${MAL_API_BASE}/manga?q=${encodeURIComponent(query)}&limit=${PIVOT_SEARCH_LIMIT}&fields=${encodeURIComponent(MAL_PIVOT_FIELDS)}`;
    const cacheKey = `mal:pivot:${query.toLowerCase()}`;

    // Jeton MAL : Bearer user si connecté (validé Q-b : les endpoints publics
    // servent le même corps en Bearer et en X-MAL-CLIENT-ID), sinon repli
    // X-MAL-CLIENT-ID si premium. Non-premium sans jeton → mode dégradé (Q-c) :
    // AUCUN appel MAL sortant, on sert un hit de cache partagé s'il existe, sinon
    // la notice BnF seule (bnf_only).
    const tokenResolution = await this.tokenResolver.resolve(ctx.userId, 'mal');
    let raw: MalSearchResponse;
    if (tokenResolution.source === 'none') {
      const cached = await this.cache.get<MalSearchResponse>(cacheKey);
      if (!cached) {
        this.logger.warn(
          `pivot: mode degrade (pas de jeton MAL, pas de cache) isbn=${isbn} -> bnf seule`,
        );
        return this.bnfOnlyResult(notice, isbn);
      }
      raw = cached;
    } else {
      // Fast-fail typé : repli premium demandé mais client-id serveur absent (le worker
      // échouerait de toute façon en X-MAL-CLIENT-ID).
      if (tokenResolution.source === 'fallback' && !this.clientId) {
        this.logger.error(
          'MAL_CLIENT_ID not configured — pivot repli impossible',
        );
        throw new ServiceUnavailableException('mal: not configured');
      }
      // Appel sortant via la file (throttle global + single-flight sur la clé de cache) ; le worker
      // résout le jeton (Bearer user ou X-MAL-CLIENT-ID serveur) et l'injecte.
      raw = await this.cache.getOrFetch<MalSearchResponse>(
        cacheKey,
        SEARCH_CACHE_TTL_SECONDS,
        () => this.enqueueFetch<MalSearchResponse>(url, cacheKey, ctx.userId),
      );
    }
    const candidates = (raw.data ?? []).map((d) => d.node);
    this.logger.log(
      `pivot: mal candidates isbn=${isbn} count=${candidates.length} titles=[${candidates
        .slice(0, 5)
        .map((c) => c.title)
        .join(' | ')}]`,
    );

    const chosen = this.choosePivotCandidate(
      candidates,
      notice.authors,
      query,
      requireAuthor,
    );
    if (!chosen) {
      this.logger.warn(
        `pivot: no MAL candidate matched ${requireAuthor ? 'author (fallback titre FR)' : 'author/type'} isbn=${isbn} -> bnf_only`,
      );
      return this.bnfOnlyResult(notice, isbn);
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
      `pivot: retained isbn=${isbn} mal_id=${chosen.node.id} title="${chosen.node.title}" media_type=${chosen.node.media_type} titleSim=${chosen.titleScore.toFixed(2)} authorMatch=${chosen.authorMatched} typeOk=${chosen.typeOk} confidence=${chosen.confidence.toFixed(2)}`,
    );

    const item = this.mapNode(chosen.node);
    // Synopsis : la note de résumé BnF (330$a) est en français quand présente ;
    // on la privilégie, avec repli sur le synopsis MAL (anglais). Cf. §3 du brief :
    // MAL ne fournit aucun synopsis localisé.
    if (notice.noteFr) {
      item.description = notice.noteFr;
    }
    item.metadata = {
      ...item.metadata,
      pivot: {
        isbn,
        confidence: chosen.confidence,
        authorMatched: chosen.authorMatched,
        resolutionPath: useOriginal ? 'bnf+mal' : 'bnf+mal-fr',
      },
      // Données du tome scanné (à reporter dans le tome créé côté client).
      scannedTome: buildScannedTomeMeta(notice, isbn),
    };

    return { items: [item], nextCursor: null };
  }

  async fetchDetails(id: string, ctx: AdapterContext): Promise<UnifiedItem> {
    const url = `${MAL_API_BASE}/manga/${encodeURIComponent(id)}?fields=${encodeURIComponent(MAL_MANGA_FIELDS)}`;
    const cacheKey = `mal:manga:${id}`;

    const raw = await this.malResolvedGet<MalMangaNode>(
      url,
      cacheKey,
      DETAILS_CACHE_TTL_SECONDS,
      ctx.userId,
    );

    return this.mapNode(raw);
  }

  // ----- Helpers privés -----

  /**
   * GET MAL via la file `mal` (throttle sortant global + single-flight sur la clé de cache), avec
   * résolution du jeton **dans le worker** (cf. `MalProcessor`) et mode dégradé côté producteur.
   *  - jeton user présent → Bearer utilisateur (worker) ;
   *  - premium sans jeton → repli `X-MAL-CLIENT-ID` serveur (worker) ;
   *  - sinon (dégradé) → cache-only, aucun enqueue ; à défaut de hit, `SourceTokenRequiredException`
   *    (403 actionnable : connecter MAL ou premium).
   * Cache partagé sur clé publique : un hit d'un autre user est réutilisable sans fuite (données MAL
   * interrogées ici publiques). Le jeton n'apparaît ni dans le cacheKey ni dans le payload du job.
   */
  private async malResolvedGet<T>(
    url: string,
    cacheKey: string,
    ttlSeconds: number,
    userId: string,
  ): Promise<T> {
    const resolution = await this.tokenResolver.resolve(userId, 'mal');

    if (resolution.source === 'none') {
      const cached = await this.cache.get<T>(cacheKey);
      if (cached !== null && cached !== undefined) return cached;
      throw new SourceTokenRequiredException('mal');
    }

    // Fast-fail typé : repli premium demandé mais client-id serveur absent. Évite d'enfiler un job
    // voué à échouer et préserve le 503 « not configured » attendu.
    if (resolution.source === 'fallback' && !this.clientId) {
      this.logger.error('MAL_CLIENT_ID not configured');
      throw new ServiceUnavailableException('mal: not configured');
    }

    return this.cache.getOrFetch<T>(cacheKey, ttlSeconds, () =>
      this.enqueueFetch<T>(url, cacheKey, userId),
    );
  }

  /**
   * Enfile un GET MAL et attend le worker. Single-flight sur la clé de cache publique (hashée car
   * BullMQ interdit `:` et les espaces dans un jobId, or la requête peut en contenir). Échec worker
   * (MAL indispo) / Redis / timeout → `BadGatewayException` (pas de mise en cache → re-tentable).
   */
  private async enqueueFetch<T>(
    url: string,
    cacheKey: string,
    userId: string,
  ): Promise<T> {
    // Circuit-breaker : Redis down → 503 immédiat plutôt que d'attendre ~15 s
    // (`waitUntilFinished`) sur le chemin interactif (cf. RedisHealthService).
    if (!this.redisHealth.isAvailable()) {
      throw new ServiceUnavailableException('mal: file indisponible (Redis)');
    }
    try {
      const job = await this.queue.add(
        MAL_FETCH_JOB,
        { userId, url },
        {
          jobId: createHash('sha1').update(cacheKey).digest('hex'),
          removeOnComplete: { age: 60, count: 500 },
          removeOnFail: true,
        },
      );
      return (await job.waitUntilFinished(this.queueEvents, MAL_WAIT_MS)) as T;
    } catch {
      throw new BadGatewayException('mal: upstream unavailable');
    }
  }

  /**
   * Consolidation : choisit le meilleur candidat MAL pour les auteurs BnF.
   * Critère d'acceptation par défaut : match auteur, OU (type manga ET premier
   * résultat). Sinon → null (on préfère ne rien retenir plutôt qu'un faux positif).
   *
   * Score = combinaison de la similarité de titre (contenance/Dice, cf. §4 du brief),
   * du match auteur et du type. La contenance du titre-requête dans le titre MAL
   * (ex "Tokyo toritsu" ⊂ "Jujutsu Kaisen 0: Tokyo Toritsu…") est un signal fort ;
   * conjuguée au match auteur elle donne un match ~certain (confidence ≈ 1).
   *
   * @param query        titre interrogé (454$t romaji, ou titleFr en repli).
   * @param requireAuthor exige le match auteur (repli sur titre FR : le titre seul
   *   ne suffit pas à valider, l'auteur est le garde-fou anti-homonyme).
   */
  private choosePivotCandidate(
    candidates: MalMangaNode[],
    bnfAuthors: BnfAuthor[],
    query: string,
    requireAuthor = false,
  ): PivotCandidate | null {
    let best: PivotCandidate | null = null;

    candidates.forEach((node, rank) => {
      const typeOk = node.media_type
        ? MANGA_MEDIA_TYPES.has(node.media_type)
        : false;
      const authorMatched = matchesAuthor(
        bnfAuthors,
        malAuthorNames(node.authors),
      );
      const titleScore = titleSimilarity(query, node.title);

      // Combinaison linéaire (max = 1.0) : titre 0.45, auteur 0.40, type 0.15.
      // "titre contenu + auteur" ≈ 0.85+, +type → 1.0 (match certain). Le rang MAL
      // ne sert que de départage infinitésimal entre scores égaux.
      let confidence =
        0.45 * titleScore +
        0.4 * (authorMatched ? 1 : 0) +
        0.15 * (typeOk ? 1 : 0);
      confidence = Math.max(0, confidence - rank * 0.001);

      const cand: PivotCandidate = {
        node,
        rank,
        authorMatched,
        typeOk,
        titleScore,
        confidence,
      };
      if (!best || cand.confidence > best.confidence) best = cand;
    });

    if (!best) return null;
    // Garde-fou anti faux-positif : exiger un signal fort.
    const b: PivotCandidate = best;
    if (requireAuthor) {
      // Repli titre FR : l'auteur est le SEUL validateur fiable (le titre a pu
      // matcher un homonyme). Pas de match auteur → on ne retient rien.
      if (!b.authorMatched) return null;
    } else if (
      !b.authorMatched &&
      !(b.typeOk && b.titleScore >= PIVOT_TITLE_STRONG)
    ) {
      // Sans auteur : on n'accepte qu'un manga dont le titre est fortement similaire
      // (contenance / Dice ≥ seuil) — pas un simple « premier résultat » douteux.
      return null;
    }
    return b;
  }

  /**
   * Repli bnf_only : MAL n'a pas (ou pas pu) enrichir, mais la notice BnF est
   * disponible. On la mappe en item plutôt que de renvoyer vide (backend#2) — un
   * scan sans jeton MAL affiche enfin la notice. La **jaquette du tome scanné** est
   * résolue par ISBN via Google Books (best-effort : `null` si absente/indisponible,
   * ne fait jamais échouer le repli — la BnF, elle, n'en fournit pas). Description =
   * note FR (330$a) si présente, `resolutionPath: 'bnf_only'`. Le tome scanné voyage
   * dans `metadata.scannedTome`, comme le chemin enrichi, pour que l'app crée le
   * tome/la série.
   *
   * Si la notice n'a aucun titre exploitable (ni série ni tome FR), il n'y a rien
   * à afficher → résultat vide.
   */
  private async bnfOnlyResult(
    notice: BnfNotice,
    isbn: string,
  ): Promise<AdapterSearchResult> {
    const title = notice.seriesTitle ?? notice.titleFr;
    if (!title) {
      return { items: [], nextCursor: null };
    }
    const coverUrl = (await this.googleBooks.resolveCover(isbn)) ?? undefined;
    const item: UnifiedItem = {
      source: 'bnf',
      sourceId: notice.ark ?? isbn,
      mediaType: 'manga',
      title,
      creators: bnfCreators(notice.authors),
      releaseDate: notice.publicationDate ?? undefined,
      coverUrl,
      description: notice.noteFr ?? undefined,
      metadata: {
        pivot: {
          isbn,
          confidence: 0,
          authorMatched: false,
          resolutionPath: 'bnf_only',
        },
        scannedTome: buildScannedTomeMeta(notice, isbn),
      },
      rawData: notice,
    };
    return { items: [item], nextCursor: null };
  }

  /**
   * Mappe une identité MangaDex en item `source='mangadex'` (chemin nominal du scan). Le `mal_id`
   * (`links.mal`) est porté dans `metadata.pivot` pour retrouver MAL trivialement plus tard (sync).
   *  - `description` (public FR) = synopsis `.fr` → note BnF 330$a → synopsis `.en` ;
   *  - `coverUrl` = jaquette principale MangaDex ;
   *  - `num_volumes` dérivé de `lastVolume` ; `rating`/`status`/`genres` en metadata.
   * Le tome scanné voyage dans `metadata.scannedTome`, comme les autres chemins.
   */
  private buildMangaDexItem(
    identity: MangaDexIdentity,
    notice: BnfNotice,
    isbn: string,
    useOriginal: boolean,
  ): UnifiedItem {
    const description =
      identity.descriptionFr ??
      notice.noteFr ??
      identity.descriptionEn ??
      undefined;
    const numVolumes = toVolumeCount(identity.lastVolume);
    return {
      source: 'mangadex',
      sourceId: identity.mangaId,
      mediaType: 'manga',
      title: identity.title,
      creators: identity.authors.length
        ? identity.authors
        : bnfCreators(notice.authors),
      releaseDate: identity.year
        ? String(identity.year)
        : (notice.publicationDate ?? undefined),
      coverUrl: identity.coverUrl ?? undefined,
      description,
      metadata: {
        pivot: {
          isbn,
          confidence: identity.confidence,
          authorMatched: identity.matchedBy === 'title+author',
          resolutionPath: useOriginal ? 'bnf+mangadex' : 'bnf+mangadex-fr',
          malId: identity.malId,
          anilistId: identity.anilistId,
          mangaId: identity.mangaId,
        },
        rating: identity.rating,
        num_volumes: numVolumes,
        status: identity.status,
        genres: identity.genres,
        scannedTome: buildScannedTomeMeta(notice, isbn),
      },
      rawData: identity,
    };
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
 * Métadonnées du tome scanné, à reporter dans le tome créé côté client. Partagé
 * par le chemin enrichi (bnf+mal) et le repli bnf_only pour garantir le même
 * contrat de sortie quelle que soit la réussite de l'enrichissement MAL.
 */
function buildScannedTomeMeta(notice: BnfNotice, isbn: string) {
  return {
    isbn,
    titleFr: notice.titleFr,
    // Titre de la SÉRIE (461$t) pour l'énumération des tomes et le nom de série —
    // distinct de titleFr qui peut être le titre du tome (ex Ki-oon "Je vais te tuer").
    seriesTitleFr: notice.seriesTitle,
    volume: notice.volume,
    edition: notice.edition,
    publisherFr: notice.publisherFr,
    sourceVolumeRange: notice.sourceVolumeRange,
    // Libellé de correspondance dérivé (ex "Tomes 1, 2, 3"). Présentation —
    // séparé de la note privée userData, à afficher en tête côté app.
    sourceVolumeLabel: volumeRangeLabel(notice.sourceVolumeRange),
  };
}

/** Noms d'auteurs BnF → chaînes affichables (forme complète, sinon "prénom nom"). */
function bnfCreators(authors: BnfAuthor[]): string[] {
  return (authors ?? [])
    .map((a) => a.full?.trim() || `${a.given ?? ''} ${a.surname ?? ''}`.trim())
    .filter((s) => s.length > 0);
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

/** Noms d'auteurs MAL → chaînes libres (prénom, nom) pour {@link matchesAuthor}. */
function malAuthorNames(
  authors: MalMangaNode['authors'],
): (string | undefined)[] {
  return (authors ?? []).flatMap((a) => [
    a.node?.first_name,
    a.node?.last_name,
  ]);
}

/** `lastVolume` MangaDex (brut) → nombre de tomes, `undefined` si non numérique. */
function toVolumeCount(lastVolume: string | null): number | undefined {
  if (!lastVolume) return undefined;
  const n = Number(lastVolume);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(cursor);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
