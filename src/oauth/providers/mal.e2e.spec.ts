import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { HttpClientService } from '../../common/http/http-client.service';
import { BnfService } from '../../common/sources/bnf/bnf.service';
import { GoogleBooksCoverService } from '../../common/sources/googlebooks/googlebooks.service';
import { MangaDexCoverService } from '../../common/sources/mangadex/mangadex.service';
import { RedisHealthService } from '../../common/redis/redis-health.service';
import { OauthCredentialsService } from '../oauth.service';
import { TokenResolverService } from '../token-resolver.service';
import { MalAdapter } from './mal.adapter';
import { MalProcessor } from './mal.processor';
import { MAL_QUEUE } from './mal.types';

/**
 * E2E de la file `mal` contre un **vrai Redis** : `MalAdapter` → file → `MalProcessor` (worker réel)
 * → `waitUntilFinished`. `HttpClientService` et `TokenResolverService` sont **stubés** (aucun appel
 * MAL, jeton contrôlé), le cache est en mémoire. On valide que le worker pose le bon header selon le
 * jeton (Bearer user vs X-MAL-CLIENT-ID serveur) et le single-flight de bout en bout.
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

describe('Mal queue (e2e, Redis réel)', () => {
  let app: INestApplication;
  let svc: MalAdapter;
  let http: { request: jest.Mock };
  let tokenResolver: { resolve: jest.Mock };
  let queue: Queue;

  beforeAll(async () => {
    process.env.MAL_CLIENT_ID = 'server-cid';
    http = { request: jest.fn() };
    tokenResolver = {
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
        BullModule.registerQueue({ name: MAL_QUEUE }),
      ],
      providers: [
        MalAdapter,
        MalProcessor,
        { provide: ApiCacheService, useValue: new InMemoryCache() },
        { provide: HttpClientService, useValue: http },
        { provide: TokenResolverService, useValue: tokenResolver },
        { provide: RedisHealthService, useValue: { isAvailable: () => true } },
        // Dépendances de MalAdapter non exercées par `search()` (pivot ISBN / OAuth) : stubs.
        { provide: OauthCredentialsService, useValue: {} },
        { provide: BnfService, useValue: {} },
        { provide: GoogleBooksCoverService, useValue: {} },
        { provide: MangaDexCoverService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    svc = app.get(MalAdapter);
    queue = app.get(getQueueToken(MAL_QUEUE));
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await app?.close();
    delete process.env.MAL_CLIENT_ID;
  });

  beforeEach(() => http.request.mockReset());

  it('repli premium : le worker pose X-MAL-CLIENT-ID serveur et l’adapter mappe', async () => {
    tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { data: [{ node: { id: 9, title: 'Naruto' } }], paging: {} },
    });

    const res = await svc.search('naruto', { userId: USER, limit: 50 });

    expect(res.items[0].sourceId).toBe('9');
    expect(http.request).toHaveBeenCalledTimes(1);
    const [, opts] = http.request.mock.calls[0];
    expect(opts.headers['X-MAL-CLIENT-ID']).toBe('server-cid');
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it('jeton user : le worker pose Authorization Bearer', async () => {
    tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: { accessToken: 'user-tok', expiresAtMs: 0, scopes: [] },
    });
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { data: [{ node: { id: 1, title: 'One Piece' } }], paging: {} },
    });

    const res = await svc.search('one piece bearer', {
      userId: USER,
      limit: 50,
    });

    expect(res.items[0].sourceId).toBe('1');
    const [, opts] = http.request.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer user-tok');
    expect(opts.headers['X-MAL-CLIENT-ID']).toBeUndefined();
  });

  it('single-flight : deux recherches concurrentes identiques → un seul appel', async () => {
    tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });
    http.request.mockImplementation(async () => {
      await delay(120);
      return {
        status: 200,
        headers: {},
        data: { data: [], paging: {} },
      };
    });

    await Promise.all([
      svc.search('berserk', { userId: USER, limit: 50 }),
      svc.search('berserk', { userId: USER, limit: 50 }),
    ]);

    expect(http.request).toHaveBeenCalledTimes(1);
  });
});
