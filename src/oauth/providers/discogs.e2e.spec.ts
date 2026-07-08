import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { HttpClientService } from '../../common/http/http-client.service';
import { RedisHealthService } from '../../common/redis/redis-health.service';
import { OauthCredentialsService } from '../oauth.service';
import { TokenResolverService } from '../token-resolver.service';
import { DiscogsAdapter } from './discogs.adapter';
import { DiscogsProcessor } from './discogs.processor';
import { DISCOGS_QUEUE } from './discogs.types';

/**
 * E2E de la file `discogs` contre un **vrai Redis** : `DiscogsAdapter` → file → `DiscogsProcessor`
 * (worker réel) → `waitUntilFinished`. `HttpClientService` et `TokenResolverService` sont **stubés**
 * (aucun appel Discogs, jeton contrôlé), le cache est en mémoire. On valide que le worker signe
 * l'appel selon le jeton résolu (OAuth 1.0a user vs consumer-only repli) et le single-flight de bout
 * en bout — le tout sans aucun secret dans le payload du job.
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

describe('Discogs queue (e2e, Redis réel)', () => {
  let app: INestApplication;
  let svc: DiscogsAdapter;
  let http: { request: jest.Mock };
  let tokenResolver: { resolve: jest.Mock };
  let queue: Queue;

  beforeAll(async () => {
    process.env.DISCOGS_CONSUMER_KEY = 'ck-e2e';
    process.env.DISCOGS_CONSUMER_SECRET = 'cs-e2e';
    process.env.DISCOGS_CALLBACK_URL =
      'http://localhost:3000/v1/oauth/discogs/callback';
    delete process.env.DISCOGS_ACERVATIM_TOKEN; // repli = signature consumer-only
    http = { request: jest.fn() };
    tokenResolver = {
      resolve: jest.fn().mockResolvedValue({ source: 'fallback' }),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        // ignoreEnvFile : hermétique — le `.env` local du repo définit DISCOGS_ACERVATIM_TOKEN, qui
        // ferait poser `Discogs token=` au lieu de la signature consumer-only qu'on veut vérifier.
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        BullModule.forRootAsync({
          useFactory: () => ({
            connection: {
              host: process.env.REDIS_HOST ?? 'localhost',
              port: Number(process.env.REDIS_PORT ?? 6379),
            },
          }),
        }),
        BullModule.registerQueue({ name: DISCOGS_QUEUE }),
      ],
      providers: [
        DiscogsAdapter,
        DiscogsProcessor,
        { provide: ApiCacheService, useValue: new InMemoryCache() },
        { provide: HttpClientService, useValue: http },
        { provide: TokenResolverService, useValue: tokenResolver },
        // Redis est réellement up dans cet e2e → le circuit-breaker laisse passer.
        { provide: RedisHealthService, useValue: { isAvailable: () => true } },
        // Dépendance de DiscogsAdapter non exercée par search() (flux OAuth) : stub.
        { provide: OauthCredentialsService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    svc = app.get(DiscogsAdapter);
    queue = app.get(getQueueToken(DISCOGS_QUEUE));
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await app?.close();
    delete process.env.DISCOGS_CONSUMER_KEY;
    delete process.env.DISCOGS_CONSUMER_SECRET;
    delete process.env.DISCOGS_CALLBACK_URL;
  });

  beforeEach(() => http.request.mockReset());

  it('repli premium : le worker signe en consumer-only et l’adapter mappe', async () => {
    tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        results: [{ id: 9, type: 'release', title: 'Air - Moon Safari' }],
        pagination: { page: 1, pages: 1 },
      },
    });

    const res = await svc.search('moon safari', { userId: USER, limit: 50 });

    expect(res.items[0].sourceId).toBe('9');
    expect(http.request).toHaveBeenCalledTimes(1);
    const [, opts] = http.request.mock.calls[0];
    expect(opts.headers.Authorization).toMatch(/^OAuth /);
    expect(opts.headers.Authorization).toContain('oauth_consumer_key="ck-e2e"');
    expect(opts.headers.Authorization).not.toContain('oauth_token=');
  });

  it('jeton user : le worker signe avec le token utilisateur (oauth_token présent)', async () => {
    tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: {
        accessToken: 'user-access',
        refreshToken: 'user-secret',
        expiresAtMs: 0,
        scopes: [],
      },
    });
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        results: [{ id: 1, type: 'release', title: 'Daft Punk - Discovery' }],
        pagination: { page: 1, pages: 1 },
      },
    });

    const res = await svc.search('discovery byot', { userId: USER, limit: 50 });

    expect(res.items[0].sourceId).toBe('1');
    const [, opts] = http.request.mock.calls[0];
    expect(opts.headers.Authorization).toContain('oauth_token="user-access"');
  });

  it('single-flight : deux recherches concurrentes identiques → un seul appel', async () => {
    tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });
    http.request.mockImplementation(async () => {
      await delay(120);
      return {
        status: 200,
        headers: {},
        data: { results: [], pagination: { page: 1, pages: 1 } },
      };
    });

    await Promise.all([
      svc.search('nina simone', { userId: USER, limit: 50 }),
      svc.search('nina simone', { userId: USER, limit: 50 }),
    ]);

    expect(http.request).toHaveBeenCalledTimes(1);
  });
});
