import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { RedisHealthService } from '../common/redis/redis-health.service';
import { BNF_QUEUE } from '../common/sources/bnf/bnf.types';
import { GBOOKS_QUEUE } from '../common/sources/googlebooks/googlebooks.types';
import { DISCOGS_QUEUE } from '../oauth/providers/discogs.types';
import { MAL_QUEUE } from '../oauth/providers/mal.types';
import { TMDB_QUEUE } from '../oauth/providers/tmdb.types';
import { EDITION_IMPORT_QUEUE } from '../search/import/edition-import.types';

/** Compteurs BullMQ d'une file à un instant t. */
export interface QueueMetric {
  name: string;
  /** En attente d'un worker libre = **backlog** (le signal de calibrage : grossit si le limiter bride). */
  waiting: number;
  /** En cours d'exécution (≤ concurrency de la file). */
  active: number;
  /** Différés par le limiter (rate-limit atteint) — autre face du backlog. */
  delayed: number;
  /**
   * Terminés encore présents. Avec `removeOnComplete: { age: 60 }`, c'est un **proxy de débit sur la
   * dernière minute** (au-delà, les jobs sont purgés).
   */
  completed: number;
  /**
   * Échecs encore présents. `removeOnFail: true` les retire aussitôt → ~toujours `0`. Les échecs
   * réels sont tracés par chaque worker (logs `*.processor.ts`). Un compteur d'échecs dédié est un
   * raffinement P3 ultérieur.
   */
  failed: number;
}

const METRICS_INTERVAL_MS = 60_000;

/**
 * Observabilité des files BullMQ (durcissement P3). Deux usages :
 *  - **log périodique conditionnel** (uniquement quand une file a du backlog / de l'activité) pour
 *    voir en prod si le limiter bride sous charge (données de **calibrage** des limiters) ;
 *  - **snapshot** exposé via l'endpoint admin `GET /admin/queues`.
 *
 * On lit `getJobCounts()` (réutilise la connexion de chaque `Queue`, aucune connexion supplémentaire).
 * Le sondage est court-circuité quand Redis est down (cf. {@link RedisHealthService}) pour ne pas
 * empiler des commandes hors-ligne.
 */
@Injectable()
export class QueueMetricsService {
  private readonly logger = new Logger(QueueMetricsService.name);
  private readonly queues: { name: string; queue: Queue }[];

  constructor(
    private readonly redisHealth: RedisHealthService,
    @InjectQueue(GBOOKS_QUEUE) gbooks: Queue,
    @InjectQueue(BNF_QUEUE) bnf: Queue,
    @InjectQueue(MAL_QUEUE) mal: Queue,
    @InjectQueue(DISCOGS_QUEUE) discogs: Queue,
    @InjectQueue(TMDB_QUEUE) tmdb: Queue,
    @InjectQueue(EDITION_IMPORT_QUEUE) editionImport: Queue,
  ) {
    this.queues = [
      { name: GBOOKS_QUEUE, queue: gbooks },
      { name: BNF_QUEUE, queue: bnf },
      { name: MAL_QUEUE, queue: mal },
      { name: DISCOGS_QUEUE, queue: discogs },
      { name: TMDB_QUEUE, queue: tmdb },
      { name: EDITION_IMPORT_QUEUE, queue: editionImport },
    ];
  }

  /** Compteurs instantanés de toutes les files (backlog, débit récent, échecs). */
  async snapshot(): Promise<QueueMetric[]> {
    return Promise.all(
      this.queues.map(async ({ name, queue }) => {
        const c = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'completed',
          'failed',
        );
        return {
          name,
          waiting: c.waiting ?? 0,
          active: c.active ?? 0,
          delayed: c.delayed ?? 0,
          completed: c.completed ?? 0,
          failed: c.failed ?? 0,
        };
      }),
    );
  }

  @Interval(METRICS_INTERVAL_MS)
  async logMetrics(): Promise<void> {
    // Rien à mesurer si Redis est down (le circuit-breaker a déjà tranché) — évite un sondage vain.
    if (!this.redisHealth.isAvailable()) return;

    let snap: QueueMetric[];
    try {
      snap = await this.snapshot();
    } catch (err) {
      this.logger.debug(`queue metrics poll failed: ${(err as Error).message}`);
      return;
    }

    // On ne logue que les files avec de l'activité/backlog — pas de spam quand tout est au repos.
    const active = snap.filter(
      (m) => m.waiting + m.active + m.delayed + m.failed > 0,
    );
    if (active.length === 0) return;

    const line = active
      .map(
        (m) =>
          `${m.name}[w${m.waiting} a${m.active} d${m.delayed} f${m.failed} c${m.completed}]`,
      )
      .join(' ');
    this.logger.log(`queues ${line}`);
  }
}
