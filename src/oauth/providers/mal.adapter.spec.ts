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
import { BnfService } from '../../common/sources/bnf/bnf.service';
import { OauthCredentialsService } from '../oauth.service';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TokenResolverService } from '../token-resolver.service';
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
  bnf: { resolveByIsbn: jest.Mock };
  tokenResolver: { resolve: jest.Mock };
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
  const bnf = { resolveByIsbn: jest.fn() };
  // Par défaut : repli premium (X-MAL-CLIENT-ID) — les tests de connexion user ou
  // de mode dégradé surchargent explicitement `resolve`.
  const tokenResolver = {
    resolve: jest.fn().mockResolvedValue({ source: 'fallback' }),
  };

  const svc = new MalAdapter(
    config,
    http as unknown as HttpClientService,
    cache as unknown as ApiCacheService,
    bucket as unknown as TokenBucketService,
    creds as unknown as OauthCredentialsService,
    bnf as unknown as BnfService,
    tokenResolver as unknown as TokenResolverService,
  );
  svc.onModuleInit();
  return {
    deps: { config, http, cache, bucket, creds, bnf, tokenResolver },
    svc,
  };
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
  it('appelle /v2/manga avec Bearer (jeton user résolu) + consume token bucket + map vers UnifiedItem', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: {
        accessToken: 'tok-user',
        expiresAtMs: Date.now() + 1000,
        scopes: [],
      },
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

  it('throw SourceTokenRequired (403) si aucun jeton résolu et pas de cache (dégradé)', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'none' });
    deps.cache.get.mockResolvedValue(null);

    await expect(
      svc.search('x', { userId: USER, limit: 10 }),
    ).rejects.toBeInstanceOf(SourceTokenRequiredException);
    expect(deps.http.request).not.toHaveBeenCalled();
  });

  it('mode dégradé (none) : sert un hit de cache partagé sans appel sortant', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'none' });
    deps.cache.get.mockResolvedValue({
      data: [{ node: { id: 7, title: 'Cached Manga' } }],
      paging: {},
    });

    const res = await svc.search('x', { userId: USER, limit: 10 });

    expect(deps.http.request).not.toHaveBeenCalled();
    expect(res.items).toHaveLength(1);
    expect(res.items[0].sourceId).toBe('7');
  });

  it('repli premium (fallback) : interroge MAL en X-MAL-CLIENT-ID, sans Bearer', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { data: [{ node: { id: 9, title: 'Naruto' } }], paging: {} },
    });

    const res = await svc.search('naruto', { userId: USER, limit: 10 });

    const [, opts] = deps.http.request.mock.calls[0];
    expect(opts.headers['X-MAL-CLIENT-ID']).toBe('cid');
    expect(opts.headers.Authorization).toBeUndefined();
    expect(res.items[0].sourceId).toBe('9');
  });

  it('repli premium (fallback) : consomme le bucket partagé acervatim:mal', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { data: [], paging: {} },
    });

    await svc.search('x', { userId: USER, limit: 10 });

    expect(deps.bucket.consume).toHaveBeenCalledWith('acervatim:mal', 120, 2);
  });

  it('429 si le bucket partagé acervatim:mal est épuisé (repli)', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });
    // Épuise UNIQUEMENT le bucket partagé Acervatim (le bucket user passe).
    deps.bucket.consume.mockImplementation((key: string) =>
      Promise.resolve(key !== 'acervatim:mal'),
    );

    const p = svc.search('x', { userId: USER, limit: 10 });
    await expect(p).rejects.toBeInstanceOf(HttpException);
    await p.catch((e) => expect(e.getStatus()).toBe(429));
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
    deps.tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: { accessToken: 't', expiresAtMs: 0, scopes: [] },
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

  it('clé de cache search partagée (provider:query, SANS userId) — repli/dégradé mutualisables, pas de fuite', async () => {
    const { deps, svc } = makeDeps();
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { data: [], paging: {} },
    });

    await svc.search('one piece', { userId: USER, limit: 50 });

    const cacheKey = deps.cache.getOrFetch.mock.calls[0][0] as string;
    expect(cacheKey).toBe('mal:search:one piece:0:50');
    expect(cacheKey).not.toContain(USER);
  });
});

describe('MalAdapter.searchByBarcode (pivot ISBN → BnF → MAL)', () => {
  const NOTICE = {
    isbn: '9782811623258',
    ark: 'http://catalogue.bnf.fr/ark:/12148/cb44459249t',
    titleFr: "L'attaque des titans",
    volume: '1',
    edition: 'Éd. colossale',
    publisherFr: 'Pika édition',
    seriesTitle: "L'attaque des titans",
    originalTitle: 'Shingeki no kyojin',
    originalTitleSource: '454$t' as const,
    sourceVolumeRange: '1-3',
    noteFr: null,
    authors: [{ surname: 'Isayama', given: 'Hajime', full: 'Hajime Isayama' }],
    publicationDate: 'DL 2015',
    ongoing: false,
  };

  function malManga(node: Record<string, unknown>) {
    return {
      status: 200,
      headers: {},
      data: { data: [{ node }], paging: {} },
    };
  }

  it('résout via BnF (X-MAL-CLIENT-ID public), retient le match auteur et porte le 454$h dans metadata.scannedTome', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({ ok: true, notice: NOTICE });
    deps.http.request.mockResolvedValue(
      malManga({
        id: 23390,
        title: 'Shingeki no Kyojin',
        media_type: 'manga',
        status: 'finished',
        num_volumes: 34,
        authors: [
          {
            node: { first_name: 'Hajime', last_name: 'Isayama' },
            role: 'Story & Art',
          },
        ],
      }),
    );

    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });

    // Recherche MAL en accès public (pas de Bearer user).
    const [url, opts] = deps.http.request.mock.calls[0];
    expect(url).toContain('q=Shingeki%20no%20kyojin');
    expect(opts.headers['X-MAL-CLIENT-ID']).toBe('cid');
    expect(opts.headers.Authorization).toBeUndefined();

    expect(res.items).toHaveLength(1);
    expect(res.items[0].sourceId).toBe('23390');
    const meta = res.items[0].metadata as Record<string, any>;
    expect(meta.pivot).toMatchObject({
      authorMatched: true,
      resolutionPath: 'bnf+mal',
    });
    expect(meta.scannedTome).toMatchObject({
      edition: 'Éd. colossale',
      sourceVolumeRange: '1-3',
      volume: '1',
      seriesTitleFr: "L'attaque des titans", // 461$t, pour énumérer les tomes
    });
  });

  it('pivot avec jeton user : interroge MAL en Bearer (pas de X-MAL-CLIENT-ID)', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: { accessToken: 'tok-user', expiresAtMs: 0, scopes: [] },
    });
    deps.bnf.resolveByIsbn.mockResolvedValue({ ok: true, notice: NOTICE });
    deps.http.request.mockResolvedValue(
      malManga({
        id: 23390,
        title: 'Shingeki no Kyojin',
        media_type: 'manga',
        authors: [
          {
            node: { first_name: 'Hajime', last_name: 'Isayama' },
            role: 'Story & Art',
          },
        ],
      }),
    );

    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });

    const [, opts] = deps.http.request.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer tok-user');
    expect(opts.headers['X-MAL-CLIENT-ID']).toBeUndefined();
    expect(res.items[0].sourceId).toBe('23390');
  });

  it('mode dégradé (non-premium sans jeton, pas de cache) : notice BnF seule, aucun appel MAL', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'none' });
    deps.cache.get.mockResolvedValue(null);
    deps.bnf.resolveByIsbn.mockResolvedValue({ ok: true, notice: NOTICE });

    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });

    expect(res.items).toHaveLength(0);
    expect(deps.http.request).not.toHaveBeenCalled();
    expect(deps.bucket.consume).not.toHaveBeenCalled();
  });

  it('sélectionne par contenance de titre + auteur même si un leurre est au rang 0 (Tokyo toritsu → JJK 0)', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: true,
      notice: {
        ...NOTICE,
        titleFr: "L'école d'exorcisme de Tokyo",
        edition: null,
        originalTitle: 'Tokyo toritsu',
        sourceVolumeRange: null,
        authors: [{ surname: 'Akutami', given: 'Gege', full: 'Gege Akutami' }],
      },
    });
    // Rang 0 = leurre (bon type, mauvais auteur, titre non contenu) ; rang 1 = JJK 0
    // (titre-requête contenu dans le titre MAL + auteur Akutami).
    deps.http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        data: [
          {
            node: {
              id: 63,
              title: 'Tokyo Ghoul:re',
              media_type: 'manga',
              authors: [
                {
                  node: { first_name: 'Sui', last_name: 'Ishida' },
                  role: 'Story & Art',
                },
              ],
            },
          },
          {
            node: {
              id: 115710,
              title:
                'Jujutsu Kaisen 0: Tokyo Toritsu Jujutsu Koutou Senmon Gakkou',
              media_type: 'manga',
              authors: [
                {
                  node: { first_name: 'Gege', last_name: 'Akutami' },
                  role: 'Story & Art',
                },
              ],
            },
          },
        ],
        paging: {},
      },
    });

    const res = await svc.searchByBarcode('9791032706688', {
      userId: USER,
      limit: 50,
    });

    expect(res.items).toHaveLength(1);
    expect(res.items[0].sourceId).toBe('115710'); // JJK, pas le leurre rang 0
    const meta = res.items[0].metadata as Record<string, any>;
    expect(meta.pivot.authorMatched).toBe(true);
    expect(meta.pivot.confidence).toBeGreaterThan(0.9); // titre contenu + auteur + type
  });

  it('renvoie 0 item si BnF ne résout pas', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: false,
      reason: 'bnf_not_found',
    });
    const res = await svc.searchByBarcode('0000000000000', {
      userId: USER,
      limit: 50,
    });
    expect(res.items).toHaveLength(0);
    expect(deps.http.request).not.toHaveBeenCalled();
  });

  it('rejette un candidat sans match auteur ni type (anti faux-positif)', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({ ok: true, notice: NOTICE });
    deps.http.request.mockResolvedValue(
      malManga({
        id: 999,
        title: 'Autre oeuvre',
        media_type: 'light_novel',
        authors: [
          { node: { first_name: 'Ryo', last_name: 'Kawakami' }, role: 'Story' },
        ],
      }),
    );
    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });
    expect(res.items).toHaveLength(0);
  });

  it('fallback titre FR quand pas de titre original : interroge MAL avec titleFr, valide par auteur (resolutionPath bnf+mal-fr)', async () => {
    const { deps, svc } = makeDeps();
    // Cas "Black torch" : titre latin identique à l'original, mais 454$t/500$a absents.
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: true,
      notice: {
        ...NOTICE,
        titleFr: 'Black torch',
        originalTitle: null,
        originalTitleSource: null,
        authors: [{ surname: 'Takaki', full: 'Tsuyoshi Takaki' }],
      },
    });
    deps.http.request.mockResolvedValue(
      malManga({
        id: 113399,
        title: 'Black Torch',
        media_type: 'manga',
        authors: [
          {
            node: { first_name: 'Tsuyoshi', last_name: 'Takaki' },
            role: 'Story & Art',
          },
        ],
      }),
    );

    const res = await svc.searchByBarcode('9791032701881', {
      userId: USER,
      limit: 50,
    });

    // MAL interrogé avec le titre FR (repli).
    const [url] = deps.http.request.mock.calls[0];
    expect(url).toContain('q=Black%20torch');

    expect(res.items).toHaveLength(1);
    expect(res.items[0].sourceId).toBe('113399');
    const meta = res.items[0].metadata as Record<string, any>;
    expect(meta.pivot).toMatchObject({
      authorMatched: true,
      resolutionPath: 'bnf+mal-fr',
    });
  });

  it('fallback titre FR : rejette si aucun match auteur (le titre seul ne suffit pas, anti-homonyme)', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: true,
      notice: {
        ...NOTICE,
        titleFr: 'Black torch',
        originalTitle: null,
        originalTitleSource: null,
        authors: [{ surname: 'Takaki', full: 'Tsuyoshi Takaki' }],
      },
    });
    // Premier résultat de bon type mais AUTRE auteur : accepté en pivot normal
    // (type+rang0), refusé en fallback FR (requireAuthor).
    deps.http.request.mockResolvedValue(
      malManga({
        id: 42,
        title: 'Black Torch (homonyme)',
        media_type: 'manga',
        authors: [
          { node: { first_name: 'Someone', last_name: 'Else' }, role: 'Story' },
        ],
      }),
    );

    const res = await svc.searchByBarcode('9791032701881', {
      userId: USER,
      limit: 50,
    });
    expect(deps.http.request).toHaveBeenCalled(); // MAL bien interrogé…
    expect(res.items).toHaveLength(0); // …mais rien retenu sans match auteur.
  });

  it('bnf_only si ni titre original ni titre FR (aucune requête MAL)', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: true,
      notice: {
        ...NOTICE,
        titleFr: null,
        originalTitle: null,
        originalTitleSource: null,
      },
    });
    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });
    expect(res.items).toHaveLength(0);
    expect(deps.http.request).not.toHaveBeenCalled();
  });

  it('privilégie la note BnF FR (330$a) comme description, sinon synopsis MAL', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: true,
      notice: { ...NOTICE, noteFr: 'Résumé en français depuis la BnF.' },
    });
    deps.http.request.mockResolvedValue(
      malManga({
        id: 23390,
        title: 'Shingeki no Kyojin',
        media_type: 'manga',
        synopsis: 'English synopsis from MAL.',
        authors: [
          {
            node: { first_name: 'Hajime', last_name: 'Isayama' },
            role: 'Story & Art',
          },
        ],
      }),
    );

    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });
    expect(res.items[0].description).toBe('Résumé en français depuis la BnF.');
  });
});
