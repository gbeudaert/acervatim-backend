import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { HttpClientService } from '../../common/http/http-client.service';
import { TokenResolverService } from '../token-resolver.service';
import { TmdbAdapter } from './tmdb.adapter';
import { TmdbProcessor } from './tmdb.processor';
import { TMDB_QUEUE } from './tmdb.types';

/**
 * E2E de la file `tmdb` contre un **vrai Redis** : `TmdbAdapter` → file → `TmdbProcessor` (worker
 * réel) → `waitUntilFinished`. `HttpClientService` et `TokenResolverService` sont **stubés** (aucun
 * appel TMDB, jeton contrôlé), le cache est en mémoire. On valide que le worker résout le jeton et
 * **injecte la clé** dans l'URL, et le single-flight de bout en bout.
 */

class InMemoryCache {
  readonly store = new Map<string, unknown>();
  async getOrFetch<T>(
    key: string,
    _ttl: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    if (this.store.has(key)) return this.store.get(key) as T;
    const v = await fetcher();
    this.store.set(key, v);
    return v;
  }
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async set<T>(key: string, v: T): Promise<void> {
    this.store.set(key, v);
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

describe('Tmdb queue (e2e, Redis réel)', () => {
  let app: INestApplication;
  let svc: TmdbAdapter;
  let http: { request: jest.Mock };
  let queue: Queue;

  beforeAll(async () => {
    process.env.TMDB_API_KEY = 'server-key';
    http = { request: jest.fn() };
    const tokenResolver = {
      resolve: jest.fn().mockResolvedValue({ source: 'fallback' }),
    };
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
        BullModule.registerQueue({ name: TMDB_QUEUE }),
      ],
      providers: [
        TmdbAdapter,
        TmdbProcessor,
        { provide: ApiCacheService, useValue: new InMemoryCache() },
        { provide: HttpClientService, useValue: http },
        { provide: TokenResolverService, useValue: tokenResolver },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    svc = app.get(TmdbAdapter);
    queue = app.get(getQueueToken(TMDB_QUEUE));
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await app?.close();
    delete process.env.TMDB_API_KEY;
  });

  beforeEach(() => http.request.mockReset());

  it('search : le worker injecte la clé serveur et l’adapter mappe', async () => {
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        page: 1,
        total_pages: 1,
        results: [{ id: 550, title: 'Fight Club' }],
      },
    });

    const res = await svc.search('fight club', { userId: USER, limit: 20 });

    expect(res.items[0].sourceId).toBe('550');
    expect(http.request).toHaveBeenCalledTimes(1);
    expect(http.request.mock.calls[0][0]).toContain('api_key=server-key');
  });

  it('single-flight : deux recherches concurrentes identiques → un seul appel', async () => {
    http.request.mockImplementation(async () => {
      await delay(120);
      return {
        status: 200,
        headers: {},
        data: { page: 1, total_pages: 1, results: [] },
      };
    });

    await Promise.all([
      svc.search('interstellar', { userId: USER, limit: 20 }),
      svc.search('interstellar', { userId: USER, limit: 20 }),
    ]);

    expect(http.request).toHaveBeenCalledTimes(1);
  });
});
