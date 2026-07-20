import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisHealthService } from '../../common/redis/redis-health.service';
import {
  ApiJobState,
  EDITION_IMPORT_JOB,
  EDITION_IMPORT_QUEUE,
  EditionImportJobData,
  EditionImportResult,
  EditionImportStatus,
  asProgress,
  editionImportJobId,
  mapJobState,
} from './edition-import.types';

/**
 * Producteur des jobs d'import de série (fire-and-poll). `enqueue` est **idempotent** : l'id de job
 * est déterministe (cf. {@link editionImportJobId}), donc deux demandes identiques — y compris de
 * deux utilisateurs — partagent le même job (dédup inter-user). `status` sert le polling de l'app.
 */
@Injectable()
export class EditionImportService {
  constructor(
    @InjectQueue(EDITION_IMPORT_QUEUE)
    private readonly queue: Queue<EditionImportJobData, EditionImportResult>,
    private readonly redisHealth: RedisHealthService,
  ) {}

  /**
   * Enfile (ou réutilise) l'import d'une édition. Un job déjà en file / en cours / terminé est
   * **renvoyé tel quel** (le client re-tape `edition-mapping` s'il est `done`) ; un job **échoué**
   * est purgé puis relancé (l'échec doit rester re-tentable).
   */
  async enqueue(
    title: string,
    edition?: string,
    malId?: string,
  ): Promise<{ jobId: string; state: ApiJobState }> {
    // Circuit-breaker : Redis down → 503 immédiat (l'app retombe sur son import local). Évite
    // d'attendre l'erreur de connexion BullMQ (cf. RedisHealthService).
    if (!this.redisHealth.isAvailable()) {
      throw new ServiceUnavailableException(
        'import: file indisponible (Redis)',
      );
    }
    const jobId = editionImportJobId(title, edition ?? null);

    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== 'failed') {
        return { jobId, state: mapJobState(state) };
      }
      // Échec précédent : on purge pour pouvoir ré-enfiler sous le même id.
      await existing.remove();
    }

    await this.queue.add(
      EDITION_IMPORT_JOB,
      { title, edition: edition ?? null, malId: malId ?? null },
      {
        jobId,
        // Complétion gardée assez longtemps pour que l'app poll voie `done` ; échec retiré vite
        // pour rester re-tentable.
        removeOnComplete: { age: 3600, count: 200 },
        removeOnFail: true,
      },
    );
    return { jobId, state: 'queued' };
  }

  /** Statut d'un job pour le polling ; `null` si l'id est inconnu (job jamais créé ou purgé). */
  async status(jobId: string): Promise<EditionImportStatus | null> {
    if (!this.redisHealth.isAvailable()) {
      throw new ServiceUnavailableException(
        'import: file indisponible (Redis)',
      );
    }
    const job = await this.queue.getJob(jobId);
    if (!job) return null;
    const state = await job.getState();
    return {
      jobId,
      state: mapJobState(state),
      progress: asProgress(job.progress),
    };
  }
}
