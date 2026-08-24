import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents } from 'bullmq';
import { ApiCacheService } from '../../cache/api-cache.service';
import { RedisHealthService } from '../../redis/redis-health.service';
import {
  CachedCover,
  CachedVolumeInfo,
  CoverHint,
  CoverResult,
  GBOOKS_COVER_JOB,
  GBOOKS_QUEUE,
  GBOOKS_VOLUME_INFO_JOB,
  GBooksJobData,
  GBooksJobResult,
  VolumeInfo,
  cachedStatus,
  coverCacheKey,
  normalizeIsbn,
  volumeInfoCacheKey,
} from './googlebooks.types';

export type { CoverHint, CoverResult, VolumeInfo } from './googlebooks.types';

// Deux « vides » distincts (cf. CoverStatus) : `ABSENT` = pas de jaquette, définitif (ISBN invalide) ;
// `UNRESOLVED` = non déterminé/transitoire (Redis down, timeout d'attente, pas encore résolu).
const ABSENT: CoverResult = {
  coverUrl: null,
  description: null,
  status: 'absent',
};
const UNRESOLVED: CoverResult = {
  coverUrl: null,
  description: null,
  status: 'unresolved',
};

// Plafond d'attente d'une résolution (best-effort) : au-delà on rend `null` sans casser l'appelant.
// Couvre le cas Redis lent/indisponible et une file engorgée.
const WAIT_TIMEOUT_MS = 15_000;

/**
 * **Producteur** de résolutions de jaquette Google Books — seule source d'illustration par
 * tome/volume (la BnF est bibliographique, MAL ne fournit qu'un visuel de série).
 *
 * Pipeline : cache (`ApiCache`) → sinon **enqueue** sur la file BullMQ `gbooks` (throttle sortant
 * global + **single-flight** via `jobId`) → attente du résultat du worker. Best-effort : ne jette
 * jamais (Redis down, échec Google, timeout → `null`), pour ne pas casser l'énumération d'édition.
 */
@Injectable()
export class GoogleBooksCoverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GoogleBooksCoverService.name);
  private queueEvents!: QueueEvents;

  constructor(
    @InjectQueue(GBOOKS_QUEUE)
    private readonly queue: Queue<GBooksJobData, GBooksJobResult>,
    private readonly config: ConfigService,
    private readonly cache: ApiCacheService,
    private readonly redisHealth: RedisHealthService,
  ) {}

  onModuleInit(): void {
    // QueueEvents a besoin de sa propre connexion pour recevoir les événements de complétion
    // sur lesquels `waitUntilFinished` s'appuie.
    this.queueEvents = new QueueEvents(GBOOKS_QUEUE, {
      connection: {
        host: this.config.get<string>('REDIS_HOST', 'localhost'),
        port: this.config.get<number>('REDIS_PORT', 6379),
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents?.close();
  }

  /**
   * Lecture **cache-only** (jamais de réseau ni de file) : renvoie la jaquette déjà résolue pour cet
   * ISBN, `null` si absente du cache ou résolue sans image. Utilisé par `edition-mapping` pour rester
   * rapide sur les tomes déjà chauds.
   */
  async cachedCover(isbn: string): Promise<string | null> {
    const norm = normalizeIsbn(isbn);
    if (!norm) return null;
    const hit = await this.cache.get<CachedCover>(coverCacheKey(norm));
    return hit?.url ?? null;
  }

  /**
   * Lecture **cache-only** de la jaquette **et** du résumé (jamais de réseau ni de file). Renvoie
   * `EMPTY` si l'ISBN n'est pas encore résolu. Sert à `SearchService.editionMapping` (endpoint HTTP)
   * pour répondre en < 1 s même à froid : le réchauffage réel passe par le worker d'import qui, lui,
   * appelle {@link resolveCoverAndDescription}. Évite le timeout client (incident 0.5.3 / 0.6.2).
   */
  async cachedCoverAndDescription(isbn: string): Promise<CoverResult> {
    const norm = normalizeIsbn(isbn);
    if (!norm) return ABSENT;
    const hit = await this.cache.get<CachedCover>(coverCacheKey(norm));
    // Absent du cache = pas encore résolu (le worker d'import le réchauffe) → `unresolved`, PAS `absent`.
    if (!hit) return UNRESOLVED;
    return {
      coverUrl: hit.url,
      description: hit.description ?? null,
      status: cachedStatus(hit),
    };
  }

  /** {@link resolveCoverAndDescription} en ne renvoyant que l'URL de jaquette. */
  async resolveCover(isbn: string, hint?: CoverHint): Promise<string | null> {
    return (await this.resolveCoverAndDescription(isbn, hint)).coverUrl;
  }

  /**
   * Résout jaquette + résumé d'un tome. Hit de cache → immédiat. Sinon on enfile un job `gbooks`
   * (dédup par `jobId` = clé de cache → deux demandes identiques concurrentes ne déclenchent qu'un
   * seul appel sortant) et on attend son résultat. Le worker met en cache (2xx uniquement).
   */
  async resolveCoverAndDescription(
    isbn: string,
    hint?: CoverHint,
  ): Promise<CoverResult> {
    const norm = normalizeIsbn(isbn);
    if (!norm) return ABSENT;

    const key = coverCacheKey(norm);
    const cached = await this.cache.get<CachedCover>(key);
    if (cached) {
      return {
        coverUrl: cached.url,
        description: cached.description ?? null,
        status: cachedStatus(cached),
      };
    }

    // Circuit-breaker : Redis down → best-effort tout de suite, statut `unresolved` (transitoire :
    // l'appelant pourra re-tenter). Sans ça, l'énumération d'une édition (jusqu'à ~30 tomes)
    // attendrait 15 s par tome avant de dégrader (cf. RedisHealthService).
    if (!this.redisHealth.isAvailable()) {
      return UNRESOLVED;
    }

    try {
      const job = await this.queue.add(
        GBOOKS_COVER_JOB,
        { isbn: norm, hint: hint ?? null },
        {
          // Single-flight : un job par ISBN. Complétion gardée quelques secondes pour que
          // `waitUntilFinished` lise l'état même si l'événement a été manqué (le cache long TTL
          // court-circuite tout ré-enqueue dans cette fenêtre).
          jobId: key,
          removeOnComplete: { age: 60, count: 500 },
          // Retry job-level à backoff exponentiel LONG : les 503 Google arrivent en vagues que le
          // retry HTTP (~2 s) ne peut pas traverser. On laisse BullMQ retenter le job APRÈS la vague,
          // en arrière-plan — il met en cache dès qu'une tentative réussit. `waitUntilFinished` (15 s)
          // rend `null` sur la 1ʳᵉ vague, mais le poll suivant de `edition-mapping` sert le cache
          // réchauffé (intention « cache warming »).
          // Horizon relevé à 5 tentatives (15/30/60/120 s, soit ~3,75 min cumulés) après le prod
          // 0.6.1 où une vague 503 a duré ~6 min et débordait l'ancien horizon (3 tentatives, ~45 s) :
          // toutes les fenêtres tombaient dans la vague et le job échouait définitivement (jaquettes
          // jamais réchauffées de la session). Pendant ces retries (état `delayed`) le single-flight
          // tient : un doublon concurrent dédup sur le même jobId. `removeOnFail` ne s'applique
          // qu'après épuisement → l'échec définitif reste re-tentable au prochain scan (jobId libéré).
          attempts: 5,
          backoff: { type: 'exponential', delay: 15_000 },
          removeOnFail: true,
        },
      );
      return (await job.waitUntilFinished(
        this.queueEvents,
        WAIT_TIMEOUT_MS,
      )) as CoverResult;
    } catch {
      // Redis indisponible, worker en échec (réseau/quota Google) ou timeout d'attente : best-effort
      // → `unresolved` (transitoire), jamais d'exception (ne casse pas l'énumération d'édition). Le
      // worker retente en arrière-plan ; le prochain passage servira le cache réchauffé.
      this.logger.warn(`gbooks: resolve failed isbn=${norm}`);
      return UNRESOLVED;
    }
  }

  /**
   * **Titre par ISBN** — maillon d'entrée du repli `Google Books → MangaDex` (scan d'un ISBN que la
   * BnF ne connaît pas : nouveauté non cataloguée, éditeur non français). Même pipeline que la
   * jaquette : cache → enqueue `gbooks` (throttle + single-flight) → attente du worker.
   *
   * Best-effort : `null` couvre les trois vides — ISBN invalide, Google ne connaît pas cet ISBN
   * (négatif caché), échec/timeout (cache négatif court, retry BullMQ en fond). L'appelant
   * ({@link MalAdapter}) rend alors un résultat vide plutôt que d'échouer.
   */
  async resolveVolumeInfo(isbn: string): Promise<VolumeInfo | null> {
    const norm = normalizeIsbn(isbn);
    if (!norm) return null;

    const key = volumeInfoCacheKey(norm);
    const cached = await this.cache.get<CachedVolumeInfo>(key);
    if (cached) return cached.info;

    if (!this.redisHealth.isAvailable()) return null;

    try {
      const job = await this.queue.add(
        GBOOKS_VOLUME_INFO_JOB,
        { isbn: norm },
        {
          // jobId distinct de celui de la jaquette (clés de cache distinctes) : les deux jobs du
          // même ISBN coexistent sans se dédupliquer l'un l'autre.
          jobId: key,
          removeOnComplete: { age: 60, count: 500 },
          // Horizon de retry plus court que la jaquette (5 tentatives / ~3,75 min) : ce chemin est
          // interactif (un scan attend), et le cache négatif `FAIL_TTL` couvre la vague 503 le temps
          // que ces trois tentatives réchauffent le cache pour le scan suivant.
          attempts: 3,
          backoff: { type: 'exponential', delay: 15_000 },
          removeOnFail: true,
        },
      );
      const res = (await job.waitUntilFinished(
        this.queueEvents,
        WAIT_TIMEOUT_MS,
      )) as CachedVolumeInfo;
      return res?.info ?? null;
    } catch {
      this.logger.warn(`gbooks: volume-info failed isbn=${norm}`);
      return null;
    }
  }
}
