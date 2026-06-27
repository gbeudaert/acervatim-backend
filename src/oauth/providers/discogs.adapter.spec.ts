import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { HttpClientService } from '../../common/http/http-client.service';
import { TokenBucketService } from '../../common/rate-limit/token-bucket.service';
import { OauthCredentialsService } from '../oauth.service';
import { DiscogsAdapter } from './discogs.adapter';

interface MockDeps {
  config: ConfigService;
  http: { request: jest.Mock };
  cache: {
    get: jest.Mock;
    set: jest.Mock;
    delete: jest.Mock;
    getOrFetch: jest.Mock;
  };
  bucket: { consume: jest.Mock };
  creds: {
    store: jest.Mock;
    get: jest.Mock;
    remove: jest.Mock;
    listConnected: jest.Mock;
  };
}

function makeConfig(
  overrides: Record<string, string | undefined> = {},
): ConfigService {
  const env: Record<string, string | undefined> = {
    DISCOGS_CONSUMER_KEY: 'ck-test',
    DISCOGS_CONSUMER_SECRET: 'cs-test',
    DISCOGS_CALLBACK_URL: 'http://localhost:3000/v1/oauth/discogs/callback',
    ...overrides,
  };
  return { get: jest.fn((k: string) => env[k]) } as unknown as ConfigService;
}

function makeDeps(configOverrides: Record<string, string | undefined> = {}): {
  deps: MockDeps;
  svc: DiscogsAdapter;
} {
  const config = makeConfig(configOverrides);
  const http = { request: jest.fn() };
  // getOrFetch : par défaut on cache-miss et on appelle le fetcher (comportement réel souhaité dans les tests).
  const cache = {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    getOrFetch: jest.fn(
      async (_k: string, _ttl: number, fetcher: () => Promise<unknown>) =>
        fetcher(),
    ),
  };
  const bucket = { consume: jest.fn().mockResolvedValue(true) };
  const creds = {
    store: jest.fn(),
    get: jest.fn().mockResolvedValue(null),
    remove: jest.fn(),
    listConnected: jest.fn(),
  };

  const svc = new DiscogsAdapter(
    config,
    http as unknown as HttpClientService,
    cache as unknown as ApiCacheService,
    bucket as unknown as TokenBucketService,
    creds as unknown as OauthCredentialsService,
  );
  svc.onModuleInit();
  return { deps: { config, http, cache, bucket, creds }, svc };
}

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

describe('DiscogsAdapter — config', () => {
  it("throw ServiceUnavailable si consumer key/secret absents (mais l'app boot quand même)", async () => {
    const { svc } = makeDeps({
      DISCOGS_CONSUMER_KEY: undefined,
      DISCOGS_CONSUMER_SECRET: undefined,
    });
    await expect(svc.start(USER)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('DiscogsAdapter.start (OAuth 1.0a request_token)', () => {
  it("appelle /oauth/request_token avec Authorization OAuth, persiste le pending et renvoie l'authorizeUrl", async () => {
    const { deps, svc } = makeDeps();
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: 'oauth_token=req-tok-123&oauth_token_secret=req-secret-456&oauth_callback_confirmed=true',
    });

    const res = await svc.start(USER);

    // 1. Appel HTTP correct
    expect(deps.http.request).toHaveBeenCalledTimes(1);
    const [url, opts] = deps.http.request.mock.calls[0];
    expect(url).toBe('https://api.discogs.com/oauth/request_token');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toMatch(/^OAuth /);
    expect(opts.headers.Authorization).toContain(
      'oauth_consumer_key="ck-test"',
    );
    // oauth_callback DOIT être dans la signature (cf. piège §17.9.2)
    expect(opts.headers.Authorization).toContain('oauth_signature=');

    // 2. Pending persisté avec TTL 600s, indexé par requestToken
    expect(deps.cache.set).toHaveBeenCalledWith(
      'oauth-discogs-pending:req-tok-123',
      { userId: USER, requestTokenSecret: 'req-secret-456' },
      600,
    );

    // 3. URL renvoyée
    expect(res.authorizeUrl).toBe(
      'https://www.discogs.com/oauth/authorize?oauth_token=req-tok-123',
    );
  });

  it('throw BadGateway si Discogs renvoie une payload sans oauth_token', async () => {
    const { deps, svc } = makeDeps();
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: 'error=something_went_wrong',
    });

    await expect(svc.start(USER)).rejects.toThrow(/invalid request_token/);
    expect(deps.cache.set).not.toHaveBeenCalled();
  });
});

describe('DiscogsAdapter.callback (OAuth 1.0a access_token)', () => {
  it('échange contre access_token + stocke chiffré via OauthCredentialsService + supprime le pending', async () => {
    const { deps, svc } = makeDeps();
    deps.cache.get.mockResolvedValue({
      userId: USER,
      requestTokenSecret: 'req-secret-456',
    });
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: 'oauth_token=access-tok-789&oauth_token_secret=access-secret-xyz',
    });

    const res = await svc.callback({
      oauth_token: 'req-tok-123',
      oauth_verifier: 'verif-555',
    });

    expect(res).toEqual({ userId: USER });

    // 1. Cache lookup sur le bon pending
    expect(deps.cache.get).toHaveBeenCalledWith(
      'oauth-discogs-pending:req-tok-123',
    );

    // 2. HTTP POST /oauth/access_token, signé avec request_token_secret
    const [, opts] = deps.http.request.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toContain('oauth_token="req-tok-123"');

    // 3. Credentials stockés (en clair, le chiffrement est fait dans OauthCredentialsService)
    expect(deps.creds.store).toHaveBeenCalledWith(USER, 'discogs', {
      accessToken: 'access-tok-789',
      refreshToken: 'access-secret-xyz',
      expiresAtMs: 0,
      scopes: [],
    });

    // 4. Pending nettoyé
    expect(deps.cache.delete).toHaveBeenCalledWith(
      'oauth-discogs-pending:req-tok-123',
    );
  });

  it('throw BadRequest si oauth_token ou oauth_verifier manquant', async () => {
    const { svc } = makeDeps();
    await expect(svc.callback({ oauth_token: 'x' })).rejects.toThrow(
      /required/,
    );
    await expect(svc.callback({ oauth_verifier: 'x' })).rejects.toThrow(
      /required/,
    );
  });

  it('throw BadRequest si le pending est introuvable (TTL expiré ou flow invalide)', async () => {
    const { deps, svc } = makeDeps();
    deps.cache.get.mockResolvedValue(null);

    await expect(
      svc.callback({ oauth_token: 'req', oauth_verifier: 'v' }),
    ).rejects.toThrow(/invalid or expired/);
    expect(deps.http.request).not.toHaveBeenCalled();
    expect(deps.creds.store).not.toHaveBeenCalled();
  });
});

describe('DiscogsAdapter.search', () => {
  it("consume le token bucket avant l'appel (60/min/user) et signe l'URL avec query params", async () => {
    const { deps, svc } = makeDeps();
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        results: [
          {
            id: 1,
            type: 'release',
            title: 'Miles Davis - Kind of Blue',
            year: 1959,
            cover_image: 'https://img/cover.jpg',
          },
        ],
        pagination: { page: 1, pages: 1 },
      },
    });

    const res = await svc.search('miles davis', {
      userId: USER,
      limit: 50,
    });

    // Rate limit consumé
    expect(deps.bucket.consume).toHaveBeenCalledWith(`discogs:${USER}`, 60, 1);

    // Cache hit OR fetch — par défaut getOrFetch appelle fetcher
    expect(deps.cache.getOrFetch).toHaveBeenCalledTimes(1);

    // Mapping vers UnifiedItem
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      source: 'discogs',
      sourceId: '1',
      mediaType: 'vinyl',
      title: 'Miles Davis - Kind of Blue',
      creators: ['Miles Davis'],
      releaseDate: '1959-01-01',
      coverUrl: 'https://img/cover.jpg',
    });
    expect(res.nextCursor).toBeNull();

    // Authorization OAuth présent
    const [, opts] = deps.http.request.mock.calls[0];
    expect(opts.headers.Authorization).toMatch(/^OAuth /);
  });

  it('propage nextCursor quand pagination.pages > pagination.page', async () => {
    const { deps, svc } = makeDeps();
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { results: [], pagination: { page: 1, pages: 3 } },
    });

    const res = await svc.search('jazz', { userId: USER, limit: 10 });
    expect(res.nextCursor).toBe('2');
  });

  it('throw 429 HttpException si le token bucket refuse', async () => {
    const { deps, svc } = makeDeps();
    deps.bucket.consume.mockResolvedValue(false);

    const promise = svc.search('x', { userId: USER, limit: 10 });
    await expect(promise).rejects.toBeInstanceOf(HttpException);
    await promise.catch((e) => expect(e.getStatus()).toBe(429));
    expect(deps.http.request).not.toHaveBeenCalled();
  });

  it("utilise le tokenSecret stocké dans 'refreshToken' pour signer (OAuth 1.0a)", async () => {
    const { deps, svc } = makeDeps();
    deps.creds.get.mockResolvedValue({
      accessToken: 'user-access',
      refreshToken: 'user-secret', // dans le schéma OAuth 1.0a, c'est le tokenSecret
      expiresAtMs: 0,
      scopes: [],
    });
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { results: [], pagination: { page: 1, pages: 1 } },
    });

    await svc.search('x', { userId: USER, limit: 10 });

    const [, opts] = deps.http.request.mock.calls[0];
    expect(opts.headers.Authorization).toContain('oauth_token="user-access"');
  });
});

describe('DiscogsAdapter.searchByBarcode', () => {
  it('interroge Discogs avec le paramètre `barcode=` (pas `q=`)', async () => {
    const { deps, svc } = makeDeps();
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { results: [], pagination: { page: 1, pages: 1 } },
    });

    await svc.searchByBarcode('0888072024557', { userId: USER, limit: 50 });

    expect(deps.bucket.consume).toHaveBeenCalledWith(`discogs:${USER}`, 60, 1);
    const [url] = deps.http.request.mock.calls[0];
    expect(url).toContain('barcode=0888072024557');
    expect(url).toContain('type=release');
    expect(url).not.toContain('q=');
  });

  it('mappe les résultats vers UnifiedItem comme la recherche texte', async () => {
    const { deps, svc } = makeDeps();
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        results: [{ id: 7, title: 'Daft Punk - Discovery', year: 2001 }],
        pagination: { page: 1, pages: 1 },
      },
    });

    const res = await svc.searchByBarcode('0888072024557', {
      userId: USER,
      limit: 50,
    });

    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      source: 'discogs',
      sourceId: '7',
      mediaType: 'vinyl',
      creators: ['Daft Punk'],
    });
  });
});

describe('DiscogsAdapter.fetchDetails', () => {
  it('mappe artists + images + released vers UnifiedItem', async () => {
    const { deps, svc } = makeDeps();
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        id: 42,
        title: 'Kind of Blue',
        released: '1959-08-17',
        artists: [{ name: 'Miles Davis' }, { name: 'John Coltrane' }],
        images: [
          { uri: 'https://img/full.jpg', uri150: 'https://img/thumb.jpg' },
        ],
        formats: [{ name: 'Vinyl' }],
        labels: [{ name: 'Columbia' }],
        country: 'US',
      },
    });

    const item = await svc.fetchDetails('42', { userId: USER, limit: 50 });

    expect(item).toMatchObject({
      source: 'discogs',
      sourceId: '42',
      mediaType: 'vinyl',
      title: 'Kind of Blue',
      creators: ['Miles Davis', 'John Coltrane'],
      releaseDate: '1959-08-17',
      coverUrl: 'https://img/full.jpg',
    });
    expect(item.metadata).toMatchObject({
      formats: ['Vinyl'],
      labels: ['Columbia'],
      country: 'US',
    });
  });

  it('multi-auteurs : prefere anv, strip le suffixe homonyme " (N)"', async () => {
    const { deps, svc } = makeDeps();
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        id: 100,
        title: 'Split',
        artists: [
          { name: 'Artiste1' },
          { name: 'Nirvana (2)' },
          { name: 'The Beatles', anv: 'Beatles' },
        ],
      },
    });

    const item = await svc.fetchDetails('100', { userId: USER, limit: 50 });

    expect(item.creators).toEqual(['Artiste1', 'Nirvana', 'Beatles']);
  });

  it('extrait le barcode depuis identifiers (type "Barcode", digits only)', async () => {
    const { deps, svc } = makeDeps();
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        id: 99,
        title: 'Discovery',
        identifiers: [
          { type: 'Barcode', value: '0 888072 024557', description: 'Text' },
          { type: 'Matrix / Runout', value: 'ABC-123' },
        ],
      },
    });

    const item = await svc.fetchDetails('99', { userId: USER, limit: 50 });

    expect(item.metadata).toMatchObject({ barcode: '0888072024557' });
  });
});
