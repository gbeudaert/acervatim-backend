import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { HttpClientService } from '../../common/http/http-client.service';
import { BnfService } from '../../common/sources/bnf/bnf.service';
import { GoogleBooksCoverService } from '../../common/sources/googlebooks/googlebooks.service';
import { MangaDexCoverService } from '../../common/sources/mangadex/mangadex.service';
import { MangaDexIdentity } from '../../common/sources/mangadex/mangadex.types';
import { OauthCredentialsService } from '../oauth.service';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TokenResolverService } from '../token-resolver.service';
import { MalAdapter } from './mal.adapter';
import { MAL_FETCH_JOB } from './mal.types';

interface MockDeps {
  config: ConfigService;
  http: { request: jest.Mock };
  cache: {
    get: jest.Mock;
    set: jest.Mock;
    delete: jest.Mock;
    getOrFetch: jest.Mock;
  };
  creds: {
    store: jest.Mock;
    get: jest.Mock;
    remove: jest.Mock;
    listConnected: jest.Mock;
  };
  bnf: { resolveByIsbn: jest.Mock };
  tokenResolver: { resolve: jest.Mock };
  googleBooks: {
    resolveCover: jest.Mock;
    cachedCover: jest.Mock;
    resolveCoverAndDescription: jest.Mock;
    resolveVolumeInfo: jest.Mock;
  };
  mangaDex: { identifySeries: jest.Mock };
  redisHealth: { isAvailable: jest.Mock };
  queue: { add: jest.Mock };
  waitUntilFinished: jest.Mock;
}

function makeDeps(configOverrides: Record<string, string | undefined> = {}): {
  deps: MockDeps;
  svc: MalAdapter;
} {
  const env: Record<string, string | undefined> = {
    MAL_CLIENT_ID: 'cid',
    MAL_CLIENT_SECRET: 'csec',
    MAL_CALLBACK_URL: 'http://localhost:3000/v1/oauth/mal/callback',
    ...configOverrides,
  };
  const config = {
    get: jest.fn((k: string) => env[k]),
  } as unknown as ConfigService;
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
  const creds = {
    store: jest.fn(),
    get: jest.fn().mockResolvedValue(null),
    remove: jest.fn(),
    listConnected: jest.fn(),
  };
  const bnf = { resolveByIsbn: jest.fn() };
  // Par défaut : repli premium (X-MAL-CLIENT-ID côté worker) — les tests user ou
  // dégradé surchargent explicitement `resolve`.
  const tokenResolver = {
    resolve: jest.fn().mockResolvedValue({ source: 'fallback' }),
  };
  // Par défaut : pas de jaquette Google Books (best-effort) — les tests bnf_only
  // qui vérifient l'enrichissement jaquette surchargent `resolveCover`.
  const googleBooks = {
    resolveCover: jest.fn().mockResolvedValue(null),
    cachedCover: jest.fn().mockResolvedValue(null),
    resolveCoverAndDescription: jest.fn().mockResolvedValue({
      coverUrl: null,
      description: null,
      status: 'absent',
    }),
    // Par défaut : Google ne connaît pas l'ISBN — le repli ne produit donc rien tant qu'un test ne
    // le décide pas. Les scénarios BnF historiques restent inchangés.
    resolveVolumeInfo: jest.fn().mockResolvedValue(null),
  };
  // Par défaut : MangaDex n'identifie PAS (null) → le pivot replie sur MAL, ce qui préserve les
  // scénarios MAL historiques. Les tests du chemin nominal surchargent `identifySeries`.
  const mangaDex = {
    identifySeries: jest.fn().mockResolvedValue(null),
  };
  const redisHealth = { isAvailable: jest.fn().mockReturnValue(true) };
  const waitUntilFinished = jest.fn();
  const queue = { add: jest.fn().mockResolvedValue({ waitUntilFinished }) };

  const svc = new MalAdapter(
    config,
    http as unknown as HttpClientService,
    cache as unknown as ApiCacheService,
    creds as unknown as OauthCredentialsService,
    bnf as unknown as BnfService,
    tokenResolver as unknown as TokenResolverService,
    googleBooks as unknown as GoogleBooksCoverService,
    mangaDex as unknown as MangaDexCoverService,
    redisHealth as never,
    queue as never,
  );
  // Court-circuite onModuleInit (qui ouvrirait une connexion Redis via QueueEvents) : on pose
  // les champs à la main depuis la même config.
  const s = svc as unknown as {
    clientId?: string;
    clientSecret?: string;
    callbackUrl?: string;
    queueEvents: unknown;
  };
  s.clientId = env.MAL_CLIENT_ID;
  s.clientSecret = env.MAL_CLIENT_SECRET;
  s.callbackUrl = env.MAL_CALLBACK_URL;
  s.queueEvents = {};

  return {
    deps: {
      config,
      http,
      cache,
      creds,
      bnf,
      tokenResolver,
      googleBooks,
      mangaDex,
      redisHealth,
      queue,
      waitUntilFinished,
    },
    svc,
  };
}

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

/** Corps renvoyé par le worker (res.data) : la réponse MAL brute, sans enveloppe HTTP. */
function malBody(nodes: Record<string, unknown>[], paging: unknown = {}) {
  return { data: nodes.map((node) => ({ node })), paging };
}

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
  it('enfile un job (URL /v2/manga, sans jeton) et mappe la réponse du worker', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: {
        accessToken: 'tok-user',
        expiresAtMs: Date.now() + 1000,
        scopes: [],
      },
    });
    deps.waitUntilFinished.mockResolvedValue(
      malBody([
        {
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
      ]),
    );

    const res = await svc.search('one piece', { userId: USER, limit: 50 });

    expect(deps.queue.add).toHaveBeenCalledWith(
      MAL_FETCH_JOB,
      { userId: USER, url: expect.stringContaining('/v2/manga') },
      // jobId = hash de la clé publique (BullMQ interdit ':' et espaces dans un jobId).
      expect.objectContaining({ jobId: expect.any(String) }),
    );
    const jobData = deps.queue.add.mock.calls[0][1] as { url: string };
    expect(jobData.url).toContain('q=one%20piece');

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
    expect(deps.queue.add).not.toHaveBeenCalled();
  });

  it('mode dégradé (none) : sert un hit de cache partagé sans enqueue', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'none' });
    deps.cache.get.mockResolvedValue(
      malBody([{ id: 7, title: 'Cached Manga' }]),
    );

    const res = await svc.search('x', { userId: USER, limit: 10 });

    expect(deps.queue.add).not.toHaveBeenCalled();
    expect(res.items).toHaveLength(1);
    expect(res.items[0].sourceId).toBe('7');
  });

  it('repli premium (fallback) : enfile aussi un job (header injecté au worker)', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });
    deps.waitUntilFinished.mockResolvedValue(
      malBody([{ id: 9, title: 'Naruto' }]),
    );

    const res = await svc.search('naruto', { userId: USER, limit: 10 });

    expect(deps.queue.add).toHaveBeenCalledTimes(1);
    expect(res.items[0].sourceId).toBe('9');
  });

  it('fast-fail : repli premium sans MAL_CLIENT_ID → ServiceUnavailable, aucun enqueue', async () => {
    const { deps, svc } = makeDeps({ MAL_CLIENT_ID: undefined });
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });

    await expect(
      svc.search('x', { userId: USER, limit: 10 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(deps.queue.add).not.toHaveBeenCalled();
  });

  it('échec du worker (MAL indispo / Redis / timeout) → BadGateway', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });
    deps.waitUntilFinished.mockRejectedValue(new Error('boom'));

    await expect(
      svc.search('x', { userId: USER, limit: 10 }),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('calcule nextCursor depuis paging.next + offset', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: { accessToken: 't', expiresAtMs: 0, scopes: [] },
    });
    deps.waitUntilFinished.mockResolvedValue(
      malBody([], { next: 'https://api.myanimelist.net/v2/manga?offset=50' }),
    );

    const res = await svc.search('x', { userId: USER, limit: 50 });
    expect(res.nextCursor).toBe('50'); // 0 + 50
  });

  it('clé de cache search partagée (provider:query, SANS userId) — repli/dégradé mutualisables, pas de fuite', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue(malBody([]));

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

  it('résout via BnF (file MAL), retient le match auteur et porte le 454$h dans metadata.scannedTome', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({ ok: true, notice: NOTICE });
    deps.waitUntilFinished.mockResolvedValue(
      malBody([
        {
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
        },
      ]),
    );

    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });

    // Recherche MAL enfilée (jeton résolu / header posé côté worker).
    const jobData = deps.queue.add.mock.calls[0][1] as { url: string };
    expect(jobData.url).toContain('q=Shingeki%20no%20kyojin');

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

  it('pivot avec jeton user : enfile un job (injection Bearer au worker)', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: { accessToken: 'tok-user', expiresAtMs: 0, scopes: [] },
    });
    deps.bnf.resolveByIsbn.mockResolvedValue({ ok: true, notice: NOTICE });
    deps.waitUntilFinished.mockResolvedValue(
      malBody([
        {
          id: 23390,
          title: 'Shingeki no Kyojin',
          media_type: 'manga',
          authors: [
            {
              node: { first_name: 'Hajime', last_name: 'Isayama' },
              role: 'Story & Art',
            },
          ],
        },
      ]),
    );

    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });

    expect(deps.queue.add).toHaveBeenCalledTimes(1);
    expect(res.items[0].sourceId).toBe('23390');
  });

  it('mode dégradé (non-premium sans jeton, pas de cache) : renvoie la notice BnF (bnf_only) + jaquette Google Books, aucun enqueue', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'none' });
    deps.cache.get.mockResolvedValue(null);
    deps.bnf.resolveByIsbn.mockResolvedValue({ ok: true, notice: NOTICE });
    // Jaquette du tome scanné résolue par ISBN via Google Books (backend#2, étage ②).
    deps.googleBooks.resolveCover.mockResolvedValue(
      'https://books.google.com/cover.jpg',
    );

    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });

    // Régression backend#2 : la notice BnF ne doit plus être jetée. On sert un
    // item bnf_only (série + tome scanné) sans jamais appeler MAL.
    expect(deps.queue.add).not.toHaveBeenCalled();
    expect(deps.googleBooks.resolveCover).toHaveBeenCalledWith('9782811623258');
    expect(res.items).toHaveLength(1);
    const item = res.items[0];
    expect(item.source).toBe('bnf');
    expect(item.sourceId).toBe(NOTICE.ark);
    expect(item.title).toBe("L'attaque des titans");
    expect(item.creators).toEqual(['Hajime Isayama']);
    expect(item.coverUrl).toBe('https://books.google.com/cover.jpg');
    const meta = item.metadata as Record<string, any>;
    expect(meta.pivot).toMatchObject({
      resolutionPath: 'bnf_only',
      authorMatched: false,
    });
    expect(meta.scannedTome).toMatchObject({
      isbn: '9782811623258',
      seriesTitleFr: "L'attaque des titans",
      volume: '1',
      edition: 'Éd. colossale',
      sourceVolumeRange: '1-3',
    });
  });

  it('mode dégradé sur notice sans aucun titre exploitable : rien à afficher (0 item)', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'none' });
    deps.cache.get.mockResolvedValue(null);
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: true,
      notice: { ...NOTICE, seriesTitle: null, titleFr: null },
    });

    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });

    expect(res.items).toHaveLength(0);
    expect(deps.queue.add).not.toHaveBeenCalled();
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
    deps.waitUntilFinished.mockResolvedValue(
      malBody([
        {
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
        {
          id: 115710,
          title: 'Jujutsu Kaisen 0: Tokyo Toritsu Jujutsu Koutou Senmon Gakkou',
          media_type: 'manga',
          authors: [
            {
              node: { first_name: 'Gege', last_name: 'Akutami' },
              role: 'Story & Art',
            },
          ],
        },
      ]),
    );

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
    expect(deps.queue.add).not.toHaveBeenCalled();
  });

  it('rejette un candidat sans match auteur ni type (anti faux-positif) → repli bnf_only', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({ ok: true, notice: NOTICE });
    deps.waitUntilFinished.mockResolvedValue(
      malBody([
        {
          id: 999,
          title: 'Autre oeuvre',
          media_type: 'light_novel',
          authors: [
            {
              node: { first_name: 'Ryo', last_name: 'Kawakami' },
              role: 'Story',
            },
          ],
        },
      ]),
    );
    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });
    // Le leurre MAL est bien écarté, mais la notice BnF est conservée (backend#2).
    expect(res.items).toHaveLength(1);
    expect(res.items[0].source).toBe('bnf');
    expect(res.items[0].sourceId).not.toBe('999');
    expect((res.items[0].metadata as any).pivot.resolutionPath).toBe(
      'bnf_only',
    );
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
    deps.waitUntilFinished.mockResolvedValue(
      malBody([
        {
          id: 113399,
          title: 'Black Torch',
          media_type: 'manga',
          authors: [
            {
              node: { first_name: 'Tsuyoshi', last_name: 'Takaki' },
              role: 'Story & Art',
            },
          ],
        },
      ]),
    );

    const res = await svc.searchByBarcode('9791032701881', {
      userId: USER,
      limit: 50,
    });

    // MAL interrogé avec le titre FR (repli).
    const jobData = deps.queue.add.mock.calls[0][1] as { url: string };
    expect(jobData.url).toContain('q=Black%20torch');

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
    deps.waitUntilFinished.mockResolvedValue(
      malBody([
        {
          id: 42,
          title: 'Black Torch (homonyme)',
          media_type: 'manga',
          authors: [
            {
              node: { first_name: 'Someone', last_name: 'Else' },
              role: 'Story',
            },
          ],
        },
      ]),
    );

    const res = await svc.searchByBarcode('9791032701881', {
      userId: USER,
      limit: 50,
    });
    expect(deps.queue.add).toHaveBeenCalled(); // MAL bien interrogé…
    // …l'homonyme est écarté (pas de match auteur), mais on garde la notice BnF.
    expect(res.items).toHaveLength(1);
    expect(res.items[0].source).toBe('bnf');
    expect((res.items[0].metadata as any).pivot.resolutionPath).toBe(
      'bnf_only',
    );
  });

  it('bnf_only via seriesTitle si ni titre original ni titre FR (aucune requête MAL)', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: true,
      notice: {
        ...NOTICE,
        titleFr: null,
        originalTitle: null,
        originalTitleSource: null,
        // seriesTitle (461$t) subsiste → titre exploitable, pas de pivot MAL possible.
      },
    });
    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });
    expect(deps.queue.add).not.toHaveBeenCalled();
    expect(res.items).toHaveLength(1);
    expect(res.items[0].source).toBe('bnf');
    expect(res.items[0].title).toBe("L'attaque des titans");
    expect((res.items[0].metadata as any).pivot.resolutionPath).toBe(
      'bnf_only',
    );
  });

  it('privilégie la note BnF FR (330$a) comme description, sinon synopsis MAL', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: true,
      notice: { ...NOTICE, noteFr: 'Résumé en français depuis la BnF.' },
    });
    deps.waitUntilFinished.mockResolvedValue(
      malBody([
        {
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
        },
      ]),
    );

    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });
    expect(res.items[0].description).toBe('Résumé en français depuis la BnF.');
  });
});

describe('MalAdapter.searchByBarcode (chemin nominal MangaDex, MAL en repli)', () => {
  const NOTICE = {
    isbn: '9782811623258',
    ark: 'http://catalogue.bnf.fr/ark:/12148/cb44459249t',
    titleFr: "L'attaque des titans",
    volume: '1',
    edition: null,
    publisherFr: 'Pika édition',
    seriesTitle: "L'attaque des titans",
    originalTitle: 'Shingeki no kyojin',
    originalTitleSource: '454$t' as const,
    sourceVolumeRange: null,
    noteFr: null,
    authors: [{ surname: 'Isayama', given: 'Hajime', full: 'Hajime Isayama' }],
    publicationDate: 'DL 2015',
    ongoing: false,
  };

  function makeIdentity(
    over: Partial<MangaDexIdentity> = {},
  ): MangaDexIdentity {
    return {
      mangaId: 'md-uuid-1',
      title: "L'Attaque des Titans",
      titleFr: "L'Attaque des Titans",
      titleRomaji: 'Shingeki no Kyojin',
      descriptionFr: 'Synopsis en français depuis MangaDex.',
      descriptionEn: 'English synopsis from MangaDex.',
      malId: '23390',
      anilistId: '53390',
      status: 'completed',
      year: 2009,
      lastVolume: '34',
      contentRating: 'safe',
      genres: ['Action', 'Drama'],
      authors: ['Hajime Isayama'],
      coverUrl:
        'https://uploads.mangadex.org/covers/md-uuid-1/cover.jpg.512.jpg',
      rating: 8.4,
      volumes: {},
      confidence: 0.95,
      matchedBy: 'title+author',
      ambiguous: false,
      ...over,
    };
  }

  it('identifie via MangaDex (chemin nominal) : item source=mangadex, mal_id en metadata, AUCUN appel MAL', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({ ok: true, notice: NOTICE });
    deps.mangaDex.identifySeries.mockResolvedValue(makeIdentity());

    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });

    // MangaDex interrogé avec le titre romaji (454$t) + auteurs BnF (désambiguïsation).
    expect(deps.mangaDex.identifySeries).toHaveBeenCalledWith(
      'Shingeki no kyojin',
      NOTICE.authors,
    );
    // Chemin nominal : MAL n'est PAS appelé (le mal_id est porté, pas re-résolu).
    expect(deps.queue.add).not.toHaveBeenCalled();

    expect(res.items).toHaveLength(1);
    const item = res.items[0];
    expect(item.source).toBe('mangadex');
    expect(item.sourceId).toBe('md-uuid-1');
    expect(item.coverUrl).toBe(
      'https://uploads.mangadex.org/covers/md-uuid-1/cover.jpg.512.jpg',
    );
    // Synopsis FR MangaDex prioritaire (décisif public FR).
    expect(item.description).toBe('Synopsis en français depuis MangaDex.');
    const meta = item.metadata as Record<string, any>;
    expect(meta.pivot).toMatchObject({
      resolutionPath: 'bnf+mangadex',
      malId: '23390',
      anilistId: '53390',
      mangaId: 'md-uuid-1',
      authorMatched: true,
    });
    expect(meta.num_volumes).toBe(34);
    expect(meta.status).toBe('completed');
    expect(meta.genres).toEqual(['Action', 'Drama']);
    expect(meta.scannedTome).toMatchObject({
      isbn: '9782811623258',
      seriesTitleFr: "L'attaque des titans",
      volume: '1',
    });
  });

  it('resolutionPath bnf+mangadex-fr quand la requête vient du titre FR (pas de 454$t)', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: true,
      notice: {
        ...NOTICE,
        titleFr: 'Black torch',
        originalTitle: null,
        originalTitleSource: null,
      },
    });
    deps.mangaDex.identifySeries.mockResolvedValue(
      makeIdentity({ matchedBy: 'title', malId: '113399' }),
    );

    const res = await svc.searchByBarcode('9791032701881', {
      userId: USER,
      limit: 50,
    });

    expect(deps.mangaDex.identifySeries).toHaveBeenCalledWith(
      'Black torch',
      expect.any(Array),
    );
    expect(deps.queue.add).not.toHaveBeenCalled();
    const meta = res.items[0].metadata as Record<string, any>;
    expect(meta.pivot).toMatchObject({
      resolutionPath: 'bnf+mangadex-fr',
      malId: '113399',
      authorMatched: false,
    });
  });

  it('description : repli note BnF (330$a) puis synopsis EN quand pas de synopsis FR MangaDex', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: true,
      notice: { ...NOTICE, noteFr: 'Note BnF FR.' },
    });
    deps.mangaDex.identifySeries.mockResolvedValue(
      makeIdentity({ descriptionFr: null }),
    );

    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });
    // Pas de synopsis FR MangaDex → note BnF FR prioritaire sur le synopsis EN.
    expect(res.items[0].description).toBe('Note BnF FR.');
  });

  it('MangaDex n’identifie pas (null) → repli MAL (item source=mal)', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({ ok: true, notice: NOTICE });
    deps.mangaDex.identifySeries.mockResolvedValue(null);
    deps.waitUntilFinished.mockResolvedValue(
      malBody([
        {
          id: 23390,
          title: 'Shingeki no Kyojin',
          media_type: 'manga',
          authors: [
            {
              node: { first_name: 'Hajime', last_name: 'Isayama' },
              role: 'Story & Art',
            },
          ],
        },
      ]),
    );

    const res = await svc.searchByBarcode('9782811623258', {
      userId: USER,
      limit: 50,
    });

    // Repli MAL : la file MAL est bien sollicitée.
    expect(deps.queue.add).toHaveBeenCalledTimes(1);
    expect(res.items[0].source).toBe('mal');
    expect((res.items[0].metadata as any).pivot.resolutionPath).toBe('bnf+mal');
  });
});

describe('MalAdapter.searchByBarcode (repli Google Books quand la BnF est muette)', () => {
  /** Identité MangaDex minimale, paramétrable — `ambiguous` est le pivot de ces tests. */
  function identity(over: Partial<MangaDexIdentity> = {}): MangaDexIdentity {
    return {
      mangaId: 'md-hero',
      title: 'Yuusha-kei ni Shosu',
      titleFr: null,
      titleRomaji: 'Yuusha-kei ni Shosu',
      descriptionFr: 'Synopsis FR.',
      descriptionEn: null,
      malId: '151361',
      anilistId: null,
      status: 'ongoing',
      year: 2021,
      lastVolume: '4',
      contentRating: 'safe',
      genres: ['Action'],
      authors: ['Rokurou Akashi'],
      coverUrl: 'https://uploads.mangadex.org/covers/md-hero/c.jpg.512.jpg',
      rating: 7.9,
      volumes: {},
      confidence: 0.6,
      matchedBy: 'title',
      ambiguous: false,
      ...over,
    };
  }

  /** Titre Google d'un ISBN (le repli n'a que ça comme point d'entrée). */
  function gbooksTitle(
    deps: MockDeps,
    title: string,
    authors: string[] = [],
    publishedDate: string | null = null,
  ) {
    deps.googleBooks.resolveVolumeInfo.mockResolvedValue({
      title,
      authors,
      publishedDate,
    });
  }

  it('cas fondateur : ISBN inconnu de la BnF → Google Books → MangaDex, resolutionPath gbooks+mangadex', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: false,
      reason: 'bnf_not_found',
    });
    gbooksTitle(deps, 'Sentenced to be a Hero Tome 1', [], '2026-05-22');
    // Le titre complet ne matche pas (MangaDex ne tolère pas le bruit) ; le préfixe tronqué, si.
    deps.mangaDex.identifySeries.mockImplementation((query: string) =>
      Promise.resolve(query === 'Sentenced to be a Hero' ? identity() : null),
    );

    const res = await svc.searchByBarcode('9782808703437', {
      userId: USER,
      limit: 50,
    });

    expect(res.items).toHaveLength(1);
    const item = res.items[0];
    expect(item.source).toBe('mangadex');
    const pivot = (item.metadata as { pivot: Record<string, unknown> }).pivot;
    expect(pivot.resolutionPath).toBe('gbooks+mangadex');
    expect(pivot.malId).toBe('151361');
    // Le tome vient de la queue retirée du préfixe GAGNANT, pas d'un parsing du titre brut.
    const tome = (item.metadata as { scannedTome: Record<string, unknown> })
      .scannedTome;
    expect(tome.volume).toBe('1');
    expect(tome.seriesTitleFr).toBe('Sentenced to be a Hero');
    expect(tome.titleFr).toBe('Sentenced to be a Hero Tome 1');
    // Aucune notice BnF : les champs proprement BnF restent nuls, on n'en invente pas.
    expect(tome.edition).toBeNull();
    expect(tome.publisherFr).toBeNull();
    expect(tome.sourceVolumeRange).toBeNull();
    // Le titre complet a bien été tenté avant la troncature.
    expect(deps.mangaDex.identifySeries).toHaveBeenCalledWith(
      'Sentenced to be a Hero Tome 1',
      [],
    );
  });

  it('descend l’échelle jusqu’au premier préfixe accepté, puis s’arrête', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: false,
      reason: 'bnf_not_found',
    });
    gbooksTitle(deps, 'Chainsaw Man Tome 18 . Edition collector');
    deps.mangaDex.identifySeries.mockImplementation((query: string) =>
      Promise.resolve(
        query === 'Chainsaw Man'
          ? identity({ mangaId: 'md-csm', title: 'Chainsaw Man' })
          : null,
      ),
    );

    const res = await svc.searchByBarcode('9782820352545', {
      userId: USER,
      limit: 50,
    });

    const tome = (res.items[0].metadata as { scannedTome: { volume: string } })
      .scannedTome;
    expect(tome.volume).toBe('18');
    // 3 échelons interrogés : titre complet, « Chainsaw Man Tome », « Chainsaw Man ». Les échelons
    // dont la queue n'a pas de chiffre ne coûtent aucune requête.
    expect(deps.mangaDex.identifySeries).toHaveBeenCalledTimes(3);
  });

  it('passe les auteurs Google à MangaDex quand Google en fournit (l’arbitre du rapprochement)', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: false,
      reason: 'bnf_not_found',
    });
    gbooksTitle(deps, 'Frieren', ['Kanehito Yamada']);
    deps.mangaDex.identifySeries.mockResolvedValue(
      identity({
        mangaId: 'md-frieren',
        title: 'Sousou no Frieren',
        matchedBy: 'title+author',
        ambiguous: true,
      }),
    );

    const res = await svc.searchByBarcode('9791032711897', {
      userId: USER,
      limit: 50,
    });

    expect(deps.mangaDex.identifySeries).toHaveBeenCalledWith('Frieren', [
      { full: 'Kanehito Yamada' },
    ]);
    // Ambiguë mais l'auteur a matché : on accepte (c'est le chemin des 42 % de notices avec auteurs).
    expect(res.items[0].source).toBe('mangadex');
    expect(res.items[0].title).toBe('Sousou no Frieren');
  });

  it('identification ambiguë SANS auteur → refus, item minimal gbooks_only (piège Frieren)', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: false,
      reason: 'bnf_not_found',
    });
    gbooksTitle(deps, 'Frieren');
    // Le crossover parasite « Frieren Cinnamoroll Kamigata » sortirait vainqueur du scoring.
    deps.mangaDex.identifySeries.mockResolvedValue(
      identity({
        mangaId: 'md-crossover',
        title: 'Frieren Cinnamoroll Kamigata',
        matchedBy: 'title',
        ambiguous: true,
      }),
    );

    const res = await svc.searchByBarcode('9791032711897', {
      userId: USER,
      limit: 50,
    });

    expect(res.items).toHaveLength(1);
    expect(res.items[0].source).toBe('gbooks');
    expect(res.items[0].title).toBe('Frieren');
    expect(
      (res.items[0].metadata as { pivot: { resolutionPath: string } }).pivot
        .resolutionPath,
    ).toBe('gbooks_only');
    // Le faux positif n'a fui nulle part.
    expect(JSON.stringify(res.items[0])).not.toContain('Cinnamoroll');
  });

  it('titre de tome seul (aucune série identifiée) → gbooks_only, jamais de série devinée', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: false,
      reason: 'bnf_not_found',
    });
    gbooksTitle(deps, 'Instinct grégaire');
    deps.mangaDex.identifySeries.mockResolvedValue(null);
    deps.googleBooks.resolveCoverAndDescription.mockResolvedValue({
      coverUrl: 'https://books.google.com/c.jpg',
      description: 'Résumé Google.',
      status: 'found',
    });

    const res = await svc.searchByBarcode('9791032707517', {
      userId: USER,
      limit: 50,
    });

    expect(res.items[0].source).toBe('gbooks');
    expect(res.items[0].coverUrl).toBe('https://books.google.com/c.jpg');
    const tome = (
      res.items[0].metadata as { scannedTome: Record<string, unknown> }
    ).scannedTome;
    expect(tome.seriesTitleFr).toBeNull();
    expect(tome.volume).toBeNull();
    // Un seul échelon : la queue « grégaire » n'a pas de chiffre, donc aucune troncature.
    expect(deps.mangaDex.identifySeries).toHaveBeenCalledTimes(1);
    expect(deps.mangaDex.identifySeries).toHaveBeenCalledWith(
      'Instinct grégaire',
      [],
    );
  });

  it('ISBN absent de Google Books → liste vide (il n’y a rien à proposer)', async () => {
    const { deps, svc } = makeDeps();
    deps.bnf.resolveByIsbn.mockResolvedValue({
      ok: false,
      reason: 'bnf_not_found',
    });
    deps.googleBooks.resolveVolumeInfo.mockResolvedValue(null);

    const res = await svc.searchByBarcode('9782344073674', {
      userId: USER,
      limit: 50,
    });

    expect(res.items).toEqual([]);
    expect(deps.mangaDex.identifySeries).not.toHaveBeenCalled();
  });

  it.each(['bnf_unavailable', 'bnf_unparsable'])(
    'panne BnF transitoire (%s) → AUCUN repli : l’app doit retenter, pas se rabattre',
    async (reason) => {
      const { deps, svc } = makeDeps();
      deps.bnf.resolveByIsbn.mockResolvedValue({ ok: false, reason });

      const res = await svc.searchByBarcode('9782808703437', {
        userId: USER,
        limit: 50,
      });

      expect(res.items).toEqual([]);
      expect(deps.googleBooks.resolveVolumeInfo).not.toHaveBeenCalled();
      expect(deps.mangaDex.identifySeries).not.toHaveBeenCalled();
    },
  );
});
