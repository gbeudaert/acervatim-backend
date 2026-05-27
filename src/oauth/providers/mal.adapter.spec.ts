import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { HttpClientService } from '../../common/http/http-client.service';
import { TokenBucketService } from '../../common/rate-limit/token-bucket.service';
import { OauthCredentialsService } from '../oauth.service';
import { MalAdapter } from './mal.adapter';

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
    MAL_CLIENT_ID: 'cid',
    MAL_CLIENT_SECRET: 'csec',
    MAL_CALLBACK_URL: 'http://localhost:3000/v1/oauth/mal/callback',
    ...overrides,
  };
  return { get: jest.fn((k: string) => env[k]) } as unknown as ConfigService;
}

function makeDeps(configOverrides: Record<string, string | undefined> = {}): {
  deps: MockDeps;
  svc: MalAdapter;
} {
  const config = makeConfig(configOverrides);
  const http = { request: jest.fn() };
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

  const svc = new MalAdapter(
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

describe('MalAdapter — config', () => {
  it('throw ServiceUnavailable si client_id/secret absents', async () => {
    const { svc } = makeDeps({
      MAL_CLIENT_ID: undefined,
      MAL_CLIENT_SECRET: undefined,
    });
    await expect(svc.start(USER)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('MalAdapter.start (OAuth 2.0 + PKCE plain)', () => {
  it("génère verifier + state, persiste le pending, renvoie l'authorize URL avec code_challenge=verifier (plain)", async () => {
    const { deps, svc } = makeDeps();

    const res = await svc.start(USER);

    expect(deps.cache.set).toHaveBeenCalledTimes(1);
    const [pendingKey, pendingValue, ttl] = deps.cache.set.mock.calls[0];
    expect(pendingKey).toMatch(/^oauth-mal-pending:[0-9a-f]{64}$/);
    expect(pendingValue.userId).toBe(USER);
    expect(typeof pendingValue.codeVerifier).toBe('string');
    expect(pendingValue.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(ttl).toBe(600);

    const url = new URL(res.authorizeUrl);
    expect(url.origin + url.pathname).toBe(
      'https://myanimelist.net/v1/oauth2/authorize',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('code_challenge_method')).toBe('plain');
    // MAL plain : challenge === verifier
    expect(url.searchParams.get('code_challenge')).toBe(
      pendingValue.codeVerifier,
    );
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/v1/oauth/mal/callback',
    );
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('MalAdapter.callback (échange code → access_token)', () => {
  it('POST le code + code_verifier au token endpoint, stocke chiffré, supprime le pending', async () => {
    const { deps, svc } = makeDeps();
    deps.cache.get.mockResolvedValue({
      userId: USER,
      codeVerifier: 'verifier-abc',
    });
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        access_token: 'access-XYZ',
        refresh_token: 'refresh-PQR',
        expires_in: 2419200,
        token_type: 'Bearer',
      },
    });

    const res = await svc.callback({ code: 'code-123', state: 'state-456' });
    expect(res).toEqual({ userId: USER });

    expect(deps.cache.get).toHaveBeenCalledWith('oauth-mal-pending:state-456');

    // POST body URL-encoded contient code, code_verifier, grant_type, etc.
    const [url, opts] = deps.http.request.mock.calls[0];
    expect(url).toBe('https://myanimelist.net/v1/oauth2/token');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const body = new URLSearchParams(opts.body);
    expect(body.get('code')).toBe('code-123');
    expect(body.get('code_verifier')).toBe('verifier-abc');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('client_secret')).toBe('csec');

    // Credentials stockés avec expiresAtMs calculé
    expect(deps.creds.store).toHaveBeenCalledTimes(1);
    const stored = deps.creds.store.mock.calls[0];
    expect(stored[0]).toBe(USER);
    expect(stored[1]).toBe('mal');
    expect(stored[2]).toMatchObject({
      accessToken: 'access-XYZ',
      refreshToken: 'refresh-PQR',
      scopes: [],
    });
    expect(stored[2].expiresAtMs).toBeGreaterThan(Date.now());

    expect(deps.cache.delete).toHaveBeenCalledWith(
      'oauth-mal-pending:state-456',
    );
  });

  it('throw BadRequest si code/state manquant', async () => {
    const { svc } = makeDeps();
    await expect(svc.callback({ code: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throw BadRequest si state inconnu (CSRF protection / TTL expiré)', async () => {
    const { deps, svc } = makeDeps();
    deps.cache.get.mockResolvedValue(null);
    await expect(svc.callback({ code: 'c', state: 'forged' })).rejects.toThrow(
      /invalid or expired/,
    );
    expect(deps.http.request).not.toHaveBeenCalled();
  });

  it('throw BadGateway si la réponse token ne contient pas access_token', async () => {
    const { deps, svc } = makeDeps();
    deps.cache.get.mockResolvedValue({
      userId: USER,
      codeVerifier: 'v',
    });
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { error: 'invalid_grant' },
    });
    await expect(
      svc.callback({ code: 'c', state: 's' }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(deps.creds.store).not.toHaveBeenCalled();
  });
});

describe('MalAdapter.search', () => {
  it('appelle /v2/manga avec Bearer + consume token bucket + map vers UnifiedItem', async () => {
    const { deps, svc } = makeDeps();
    deps.creds.get.mockResolvedValue({
      accessToken: 'tok-user',
      expiresAtMs: Date.now() + 1000,
      scopes: [],
    });
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        data: [
          {
            node: {
              id: 1,
              title: 'One Piece',
              main_picture: { large: 'https://img/op.jpg' },
              start_date: '1997-07-22',
              authors: [
                {
                  node: { first_name: 'Eiichiro', last_name: 'Oda' },
                  role: 'Story & Art',
                },
              ],
            },
          },
        ],
        paging: {},
      },
    });

    const res = await svc.search('one piece', { userId: USER, limit: 50 });

    expect(deps.bucket.consume).toHaveBeenCalledWith(`mal:${USER}`, 60, 1);
    const [url, opts] = deps.http.request.mock.calls[0];
    expect(url).toContain('/v2/manga');
    expect(url).toContain('q=one%20piece');
    expect(opts.headers.Authorization).toBe('Bearer tok-user');

    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      source: 'mal',
      sourceId: '1',
      mediaType: 'manga',
      title: 'One Piece',
      creators: ['Eiichiro Oda'],
      releaseDate: '1997-07-22',
      coverUrl: 'https://img/op.jpg',
    });
    expect(res.nextCursor).toBeNull();
  });

  it("throw BadRequest si l'user n'est pas connecté (token absent)", async () => {
    const { deps, svc } = makeDeps();
    deps.creds.get.mockResolvedValue(null);

    await expect(svc.search('x', { userId: USER, limit: 10 })).rejects.toThrow(
      /not connected/,
    );
    expect(deps.http.request).not.toHaveBeenCalled();
  });

  it('throw 429 HttpException si bucket plein', async () => {
    const { deps, svc } = makeDeps();
    deps.bucket.consume.mockResolvedValue(false);
    const p = svc.search('x', { userId: USER, limit: 10 });
    await expect(p).rejects.toBeInstanceOf(HttpException);
    await p.catch((e) => expect(e.getStatus()).toBe(429));
  });

  it('calcule nextCursor depuis paging.next + offset', async () => {
    const { deps, svc } = makeDeps();
    deps.creds.get.mockResolvedValue({
      accessToken: 't',
      expiresAtMs: 0,
      scopes: [],
    });
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        data: [],
        paging: { next: 'https://api.myanimelist.net/v2/manga?offset=50' },
      },
    });

    const res = await svc.search('x', { userId: USER, limit: 50 });
    expect(res.nextCursor).toBe('50'); // 0 + 50
  });
});
