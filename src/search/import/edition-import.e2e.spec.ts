import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { RedisHealthService } from '../../common/redis/redis-health.service';
import { SearchService } from '../search.service';
import { EditionImportService } from './edition-import.service';
import { EditionImportProcessor } from './edition-import.processor';
import {
  EDITION_IMPORT_QUEUE,
  EditionImportStatus,
} from './edition-import.types';

/**
 * E2E du flux fire-and-poll de l'import de série contre un **vrai Redis** : enqueue → worker (réel,
 * concurrence 1) → progression publiée → statut `done`, et dédup par jobId déterministe.
 * `SearchService` est **stubé** (aucun appel BnF/Google) : on n'exerce que la mécanique BullMQ + la
 * remontée d'avancement. Nécessite Redis via `REDIS_HOST`/`REDIS_PORT`.
 */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForDone(
  svc: EditionImportService,
  jobId: string,
  timeoutMs = 5000,
): Promise<EditionImportStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await svc.status(jobId);
    if (status && (status.state === 'done' || status.state === 'failed')) {
      return status;
    }
    if (Date.now() > deadline) throw new Error(`job ${jobId} pas fini à temps`);
    await delay(25);
  }
}

describe('EditionImport (e2e, Redis réel)', () => {
  let app: INestApplication;
  let svc: EditionImportService;
  let search: { warmEditionMapping: jest.Mock };
  let queue: Queue;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            connection: {
              host: config.get<string>('REDIS_HOST', 'localhost'),
              port: config.get<number>('REDIS_PORT', 6379),
            },
          }),
        }),
        BullModule.registerQueue({ name: EDITION_IMPORT_QUEUE }),
      ],
      providers: [
        EditionImportService,
        EditionImportProcessor,
        { provide: SearchService, useValue: { warmEditionMapping: jest.fn() } },
        { provide: RedisHealthService, useValue: { isAvailable: () => true } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    svc = app.get(EditionImportService);
    search = app.get(SearchService) as never;
    queue = app.get(getQueueToken(EDITION_IMPORT_QUEUE));
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await app?.close();
  });

  beforeEach(() => {
    search.warmEditionMapping.mockReset();
  });

  it('enqueue → worker → progression → done', async () => {
    search.warmEditionMapping.mockImplementation(
      async (
        _t: string,
        _e: string | undefined,
        onProgress: (d: number, total: number) => void,
      ) => {
        onProgress(1, 2);
        onProgress(2, 2);
        return { tomes: [{}, {}] };
      },
    );

    const created = await svc.enqueue('E2E Series A');
    expect(created.state).toBe('queued');

    const final = await waitForDone(svc, created.jobId);
    expect(final.state).toBe('done');
    expect(final.progress).toEqual({ phase: 'covers', done: 2, total: 2 });
    expect(search.warmEditionMapping).toHaveBeenCalledTimes(1);
  });

  it('dédup : deux demandes identiques → un seul job exécuté', async () => {
    // Le worker reste bloqué le temps qu'on enfile la 2e demande.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    search.warmEditionMapping.mockImplementation(
      async (
        _t: string,
        _e: string | undefined,
        onProgress: (d: number, total: number) => void,
      ) => {
        await gate;
        onProgress(1, 1);
        return { tomes: [{}] };
      },
    );

    const a = await svc.enqueue('E2E Series B');
    const b = await svc.enqueue('  e2e series b '); // même clé après normalisation
    expect(b.jobId).toBe(a.jobId);

    release();
    await waitForDone(svc, a.jobId);
    expect(search.warmEditionMapping).toHaveBeenCalledTimes(1);
  });
});
