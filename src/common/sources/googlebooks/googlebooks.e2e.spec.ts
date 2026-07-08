import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { ApiCacheService } from '../../cache/api-cache.service';
import { RedisHealthService } from '../../redis/redis-health.service';
import { GoogleBooksCoverService } from './googlebooks.service';
import { GoogleBooksProcessor } from './googlebooks.processor';
import { GoogleBooksResolver } from './googlebooks.resolver';
import { CachedCover, GBOOKS_QUEUE, coverCacheKey } from './googlebooks.types';

/**
 * E2E de la file `gbooks` contre un **vrai Redis** (BullMQ producteur → worker → QueueEvents).
 * Nécessite Redis joignable via `REDIS_HOST`/`REDIS_PORT` (cf. docker-compose service `redis`).
 *
 * On isole la mécanique BullMQ : le **resolver réseau est stubé** (aucun appel Google Books) et le
 * **cache est en mémoire** (aucune dépendance MariaDB). Ce qui est réellement exercé de bout en bout :
 * l'enqueue single-flight, l'exécution par le worker throttlé, l'attente `waitUntilFinished`, la mise
 * en cache 2xx, et le comportement best-effort.
 */

/** Cache en mémoire — remplace `ApiCacheService` (pas de MariaDB dans cet e2e). */
class InMemoryCache {
  readonly store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async set<T>(key: string, payload: T): Promise<void> {
    this.store.set(key, payload);
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('GoogleBooks queue (e2e, Redis réel)', () => {
  let app: INestApplication;
  let svc: GoogleBooksCoverService;
  let resolver: { fetchCover: jest.Mock };
  let cache: InMemoryCache;
  let queue: Queue;

  beforeAll(async () => {
    cache = new InMemoryCache();
    const moduleRef = await Test.createTestingModule({
      imports: [
        // Pas de `validate` : on ne veut que REDIS_HOST/PORT, pas tout le schéma d'env.
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
        BullModule.registerQueue({ name: GBOOKS_QUEUE }),
      ],
      providers: [
        GoogleBooksCoverService,
        GoogleBooksProcessor,
        { provide: GoogleBooksResolver, useValue: { fetchCover: jest.fn() } },
        { provide: ApiCacheService, useValue: cache },
        { provide: RedisHealthService, useValue: { isAvailable: () => true } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    svc = app.get(GoogleBooksCoverService);
    resolver = app.get(GoogleBooksResolver) as never;
    queue = app.get(getQueueToken(GBOOKS_QUEUE));
  });

  afterAll(async () => {
    // Vide la file dans Redis puis ferme worker/queue/queueEvents (via shutdown hooks).
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await app?.close();
  });

  beforeEach(() => {
    resolver.fetchCover.mockReset();
  });

  it('résout de bout en bout et met en cache le résultat (2xx)', async () => {
    resolver.fetchCover.mockResolvedValue({
      coverUrl: 'https://img/c.jpg',
      description: 'Résumé',
    });
    const isbn = '9780000000001';

    const res = await svc.resolveCoverAndDescription(isbn);

    expect(res).toEqual({
      coverUrl: 'https://img/c.jpg',
      description: 'Résumé',
    });
    expect(resolver.fetchCover).toHaveBeenCalledTimes(1);
    expect(cache.store.get(coverCacheKey(isbn))).toEqual<CachedCover>({
      url: 'https://img/c.jpg',
      description: 'Résumé',
    });
  });

  it('single-flight : N demandes concurrentes identiques → un seul appel réseau', async () => {
    // Resolver lent : garantit que les 5 demandes s'enfilent avant la 1re complétion.
    resolver.fetchCover.mockImplementation(async () => {
      await delay(150);
      return { coverUrl: 'https://img/sf.jpg', description: null };
    });
    const isbn = '9780000000002';

    const results = await Promise.all(
      Array.from({ length: 5 }, () => svc.resolveCoverAndDescription(isbn)),
    );

    expect(resolver.fetchCover).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.coverUrl).toBe('https://img/sf.jpg');
    }
  });

  it('best-effort : un échec du worker → null, rien en cache, re-tentable', async () => {
    resolver.fetchCover.mockRejectedValueOnce(new Error('google down'));
    const isbn = '9780000000003';

    const first = await svc.resolveCoverAndDescription(isbn);
    expect(first).toEqual({ coverUrl: null, description: null });
    expect(cache.store.has(coverCacheKey(isbn))).toBe(false);

    // Rien mis en cache → un 2e passage re-tente et réussit.
    resolver.fetchCover.mockResolvedValueOnce({
      coverUrl: 'https://img/retry.jpg',
      description: null,
    });
    const second = await svc.resolveCoverAndDescription(isbn);
    expect(second.coverUrl).toBe('https://img/retry.jpg');
  });

  it('hit de cache → aucun job enfilé', async () => {
    const isbn = '9780000000004';
    cache.store.set(coverCacheKey(isbn), {
      url: 'https://cached.jpg',
      description: 'x',
    });

    const res = await svc.resolveCoverAndDescription(isbn);

    expect(res).toEqual({ coverUrl: 'https://cached.jpg', description: 'x' });
    expect(resolver.fetchCover).not.toHaveBeenCalled();
  });
});
