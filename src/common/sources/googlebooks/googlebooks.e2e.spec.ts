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
import {
  CachedCover,
  CachedVolumeInfo,
  GBOOKS_QUEUE,
  coverCacheKey,
  volumeInfoCacheKey,
} from './googlebooks.types';

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
  let resolver: { fetchCover: jest.Mock; fetchVolumeInfo: jest.Mock };
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
        {
          provide: GoogleBooksResolver,
          useValue: { fetchCover: jest.fn(), fetchVolumeInfo: jest.fn() },
        },
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
    resolver.fetchVolumeInfo.mockReset();
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

  it('best-effort : un échec dur du worker → null + cache négatif court (coupe le ré-enqueue)', async () => {
    resolver.fetchCover.mockRejectedValue(new Error('google down'));
    const isbn = '9780000000003';

    const first = await svc.resolveCoverAndDescription(isbn);
    // Échec dur → `unresolved` (transitoire, à re-tenter), pas `absent`.
    expect(first).toEqual({
      coverUrl: null,
      description: null,
      status: 'unresolved',
    });
    // #1 (fix prod 0.6.2) : l'échec dur pose un cache négatif court (`unresolved`) pour couper le
    // ré-enqueue par de nouveaux scans pendant la vague 429/503 (re-tentable après expiration du TTL,
    // non testée ici : le cache en mémoire ignore le TTL).
    expect(cache.store.get(coverCacheKey(isbn))).toEqual<CachedCover>({
      url: null,
      description: null,
      status: 'unresolved',
    });

    // 2e passage immédiat : servi du cache négatif, aucun nouvel appel réseau ni ré-enqueue.
    resolver.fetchCover.mockClear();
    const second = await svc.resolveCoverAndDescription(isbn);
    expect(second).toEqual({
      coverUrl: null,
      description: null,
      status: 'unresolved',
    });
    expect(resolver.fetchCover).not.toHaveBeenCalled();
  });

  it('hit de cache → aucun job enfilé', async () => {
    const isbn = '9780000000004';
    cache.store.set(coverCacheKey(isbn), {
      url: 'https://cached.jpg',
      description: 'x',
    });

    const res = await svc.resolveCoverAndDescription(isbn);

    // Entrée sans `status` (pré-0.6.4) → ré-inféré `found` (url présente).
    expect(res).toEqual({
      coverUrl: 'https://cached.jpg',
      description: 'x',
      status: 'found',
    });
    expect(resolver.fetchCover).not.toHaveBeenCalled();
  });
  it('volume-info : titre par ISBN de bout en bout, mis en cache sous sa propre clé', async () => {
    const isbn = '9782808703437';
    resolver.fetchVolumeInfo.mockResolvedValue({
      title: 'Sentenced to be a Hero Tome 1',
      authors: ['Rokurou Akashi'],
      publishedDate: '2026-05-22',
    });

    const info = await svc.resolveVolumeInfo(isbn);

    expect(info?.title).toBe('Sentenced to be a Hero Tome 1');
    expect(resolver.fetchVolumeInfo).toHaveBeenCalledTimes(1);
    // Clé distincte de la jaquette : les deux jobs du même ISBN coexistent sans se dédupliquer.
    expect(cache.store.get(volumeInfoCacheKey(isbn))).toEqual<CachedVolumeInfo>(
      {
        info: {
          title: 'Sentenced to be a Hero Tome 1',
          authors: ['Rokurou Akashi'],
          publishedDate: '2026-05-22',
        },
      },
    );
    expect(cache.store.has(coverCacheKey(isbn))).toBe(false);

    // 2e passage : servi du cache, aucun appel réseau.
    resolver.fetchVolumeInfo.mockClear();
    expect((await svc.resolveVolumeInfo(isbn))?.title).toBe(
      'Sentenced to be a Hero Tome 1',
    );
    expect(resolver.fetchVolumeInfo).not.toHaveBeenCalled();
  });

  it('volume-info : ISBN inconnu de Google (2xx sans notice) → négatif caché, pas de re-tentative', async () => {
    const isbn = '9782344073674';
    resolver.fetchVolumeInfo.mockResolvedValue(null);

    expect(await svc.resolveVolumeInfo(isbn)).toBeNull();
    expect(cache.store.get(volumeInfoCacheKey(isbn))).toEqual<CachedVolumeInfo>(
      { info: null },
    );

    resolver.fetchVolumeInfo.mockClear();
    expect(await svc.resolveVolumeInfo(isbn)).toBeNull();
    expect(resolver.fetchVolumeInfo).not.toHaveBeenCalled();
  });

  it('volume-info : single-flight — N scans concurrents du même ISBN → un seul appel sortant', async () => {
    const isbn = '9780000000006';
    resolver.fetchVolumeInfo.mockImplementation(async () => {
      await delay(150);
      return { title: 'Blue Lock Tome 33', authors: [], publishedDate: null };
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => svc.resolveVolumeInfo(isbn)),
    );

    expect(resolver.fetchVolumeInfo).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r?.title).toBe('Blue Lock Tome 33');
  });
});
