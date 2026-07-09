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
  CoverHint,
  CoverJobData,
  CoverResult,
  GBOOKS_COVER_JOB,
  GBOOKS_QUEUE,
  coverCacheKey,
  normalizeIsbn,
} from './googlebooks.types';

export type { CoverHint, CoverResult } from './googlebooks.types';

const EMPTY: CoverResult = { coverUrl: null, description: null };

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
    private readonly queue: Queue<CoverJobData, CoverResult>,
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
    if (!norm) return EMPTY;

    const key = coverCacheKey(norm);
    const cached = await this.cache.get<CachedCover>(key);
    if (cached) {
      return { coverUrl: cached.url, description: cached.description ?? null };
    }

    // Circuit-breaker : Redis down → best-effort `null` tout de suite. Sans ça, l'énumération d'une
    // édition (jusqu'à ~30 tomes) attendrait 15 s par tome avant de dégrader (cf. RedisHealthService).
    if (!this.redisHealth.isAvailable()) {
      return EMPTY;
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
      return await job.waitUntilFinished(this.queueEvents, WAIT_TIMEOUT_MS);
    } catch {
      // Redis indisponible, worker en échec (réseau/quota Google) ou timeout d'attente :
      // best-effort → null, jamais d'exception (ne casse pas l'énumération d'édition).
      this.logger.warn(`gbooks: resolve failed isbn=${norm}`);
      return EMPTY;
    }
  }
}
