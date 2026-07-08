import { BullModule } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { RedisHealthService } from '../common/redis/redis-health.service';
import { BNF_QUEUE } from '../common/sources/bnf/bnf.types';
import { GBOOKS_QUEUE } from '../common/sources/googlebooks/googlebooks.types';
import { DISCOGS_QUEUE } from '../oauth/providers/discogs.types';
import { MAL_QUEUE } from '../oauth/providers/mal.types';
import { TMDB_QUEUE } from '../oauth/providers/tmdb.types';
import { EDITION_IMPORT_QUEUE } from '../search/import/edition-import.types';
import { QueueMetricsService } from './queue-metrics.service';

/**
 * E2E de l'agrégation des compteurs contre un **vrai Redis** : valide que les 6 files s'injectent et
 * que `getJobCounts()` répond (câblage réel BullMQ). Nécessite Redis via `REDIS_HOST`/`REDIS_PORT`.
 */
describe('QueueMetrics (e2e, Redis réel)', () => {
  let app: INestApplication;
  let svc: QueueMetricsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        BullModule.forRootAsync({
          useFactory: () => ({
            connection: {
              host: process.env.REDIS_HOST ?? 'localhost',
              port: Number(process.env.REDIS_PORT ?? 6379),
            },
          }),
        }),
        BullModule.registerQueue(
          { name: GBOOKS_QUEUE },
          { name: BNF_QUEUE },
          { name: MAL_QUEUE },
          { name: DISCOGS_QUEUE },
          { name: TMDB_QUEUE },
          { name: EDITION_IMPORT_QUEUE },
        ),
      ],
      providers: [
        QueueMetricsService,
        { provide: RedisHealthService, useValue: { isAvailable: () => true } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
    svc = app.get(QueueMetricsService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('snapshot() renvoie les 6 files avec des compteurs numériques', async () => {
    const snap = await svc.snapshot();

    expect(snap.map((m) => m.name).sort()).toEqual(
      [
        BNF_QUEUE,
        DISCOGS_QUEUE,
        EDITION_IMPORT_QUEUE,
        GBOOKS_QUEUE,
        MAL_QUEUE,
        TMDB_QUEUE,
      ].sort(),
    );
    for (const m of snap) {
      expect(typeof m.waiting).toBe('number');
      expect(typeof m.active).toBe('number');
      expect(typeof m.failed).toBe('number');
      expect(typeof m.completed).toBe('number');
    }
  });
});
