import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { HttpClientService } from '../../common/http/http-client.service';
import { OauthCredentialsService } from '../oauth.service';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TokenResolverService } from '../token-resolver.service';
import { DiscogsAdapter } from './discogs.adapter';
import { DISCOGS_FETCH_JOB } from './discogs.types';

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
  tokenResolver: { resolve: jest.Mock };
  redisHealth: { isAvailable: jest.Mock };
  queue: { add: jest.Mock };
  waitUntilFinished: jest.Mock;
}

function makeDeps(configOverrides: Record<string, string | undefined> = {}): {
  deps: MockDeps;
  svc: DiscogsAdapter;
} {
  const env: Record<string, string | undefined> = {
    DISCOGS_CONSUMER_KEY: 'ck-test',
    DISCOGS_CONSUMER_SECRET: 'cs-test',
    DISCOGS_CALLBACK_URL: 'http://localhost:3000/v1/oauth/discogs/callback',
    ...configOverrides,
  };
  const config = {
    get: jest.fn((k: string) => env[k]),
  } as unknown as ConfigService;
  const http = { request: jest.fn() };
  // getOrFetch : par défaut on cache-miss et on appelle le fetcher (comportement réel souhaité).
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
  // Par défaut : repli premium — les tests user ou dégradé surchargent explicitement `resolve`.
  const tokenResolver = {
    resolve: jest.fn().mockResolvedValue({ source: 'fallback' }),
  };
  // Par défaut : Redis disponible — le test de circuit-breaker force `false`.
  const redisHealth = { isAvailable: jest.fn().mockReturnValue(true) };
  const waitUntilFinished = jest.fn();
  const queue = { add: jest.fn().mockResolvedValue({ waitUntilFinished }) };

  const svc = new DiscogsAdapter(
    config,
    http as unknown as HttpClientService,
    cache as unknown as ApiCacheService,
    creds as unknown as OauthCredentialsService,
    tokenResolver as unknown as TokenResolverService,
    redisHealth as never,
    queue as never,
  );
  // Court-circuite onModuleInit (qui ouvrirait une connexion Redis via QueueEvents) : on pose les
  // champs à la main depuis la même config.
  const s = svc as unknown as {
    consumerKey?: string;
    consumerSecret?: string;
    callbackUrl?: string;
    acervatimToken?: string;
    queueEvents: unknown;
  };
  s.consumerKey = env.DISCOGS_CONSUMER_KEY;
  s.consumerSecret = env.DISCOGS_CONSUMER_SECRET;
  s.callbackUrl = env.DISCOGS_CALLBACK_URL;
  s.acervatimToken = env.DISCOGS_ACERVATIM_TOKEN;
  s.queueEvents = {};

  return {
    deps: {
      config,
      http,
      cache,
      creds,
      tokenResolver,
      redisHealth,
      queue,
      waitUntilFinished,
    },
    svc,
  };
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

    // 1. Appel HTTP correct (le flux OAuth reste un appel direct, hors file)
    expect(deps.http.request).toHaveBeenCalledTimes(1);
    const [url, opts] = deps.http.request.mock.calls[0];
    expect(url).toBe('https://api.discogs.com/oauth/request_token');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toMatch(/^OAuth /);
    expect(opts.headers.Authorization).toContain(
      'oauth_consumer_key="ck-test"',
    );
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

    expect(deps.cache.get).toHaveBeenCalledWith(
      'oauth-discogs-pending:req-tok-123',
    );

    const [, opts] = deps.http.request.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toContain('oauth_token="req-tok-123"');

    expect(deps.creds.store).toHaveBeenCalledWith(USER, 'discogs', {
      accessToken: 'access-tok-789',
      refreshToken: 'access-secret-xyz',
      expiresAtMs: 0,
      scopes: [],
    });

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
  it('enfile un job (single-flight, sans secret) et mappe le corps du worker vers UnifiedItem', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
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
    });

    const res = await svc.search('miles davis', { userId: USER, limit: 50 });

    // Job enfilé : nom, payload (userId + URL SANS secret), jobId hashé.
    expect(deps.queue.add).toHaveBeenCalledTimes(1);
    const [jobName, payload, opts] = deps.queue.add.mock.calls[0];
    expect(jobName).toBe(DISCOGS_FETCH_JOB);
    expect(payload).toEqual({
      userId: USER,
      url: expect.stringContaining('/database/search'),
    });
    expect(opts).toEqual(
      expect.objectContaining({ jobId: expect.any(String) }),
    );
    // Aucun appel HTTP direct côté adapter (c'est le worker qui appelle Discogs).
    expect(deps.http.request).not.toHaveBeenCalled();

    // Mapping vers UnifiedItem
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      source: 'discogs',
      sourceId: '1',
      mediaType: 'vinyl',
      // Le prefixe artiste "Miles Davis - " est retiré du titre.
      title: 'Kind of Blue',
      creators: ['Miles Davis'],
      releaseDate: '1959-01-01',
      coverUrl: 'https://img/cover.jpg',
    });
    expect(res.nextCursor).toBeNull();
  });

  it('mappe genre/style et dérive recordingSpeed depuis le tableau format plat', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      results: [
        {
          id: 2,
          type: 'release',
          title: 'Nirvana - Nevermind',
          genre: ['Rock'],
          style: ['Grunge', 'Alternative Rock'],
          format: ['Vinyl', 'LP', 'Album', '33 ⅓ RPM'],
        },
      ],
      pagination: { page: 1, pages: 1 },
    });

    const res = await svc.search('nirvana', { userId: USER, limit: 50 });

    expect(res.items[0].metadata).toMatchObject({
      genres: ['Rock'],
      styles: ['Grunge', 'Alternative Rock'],
      recordingSpeed: 'RPM_33',
    });
  });

  it('propage nextCursor quand pagination.pages > pagination.page', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      results: [],
      pagination: { page: 1, pages: 3 },
    });

    const res = await svc.search('jazz', { userId: USER, limit: 10 });
    expect(res.nextCursor).toBe('2');
  });

  it('le curseur repart en `page=` chez Discogs (la page suivante est atteignable)', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      results: [],
      pagination: { page: 2, pages: 3 },
    });

    const res = await svc.search('jazz', {
      userId: USER,
      cursor: '2',
      limit: 10,
    });

    const url = deps.queue.add.mock.calls[0][1].url as string;
    expect(url).toContain('page=2');
    expect(url).toContain('per_page=10');
    // La clé de cache porte la page : deux pages d'une même requête ne se recouvrent pas.
    expect(deps.cache.getOrFetch.mock.calls[0][0]).toBe(
      'discogs:search:q:jazz:2:10',
    );
    expect(res.nextCursor).toBe('3');
  });

  it('curseur illisible → page 1 (pas de 500 sur un curseur bricolé)', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      results: [],
      pagination: { page: 1, pages: 1 },
    });

    await svc.search('jazz', { userId: USER, cursor: 'nope', limit: 10 });

    expect(deps.queue.add.mock.calls[0][1].url as string).toContain('page=1');
  });

  it('désambiguïsation (SD1) : catno, barcodes normalisés et masterId remontent', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      results: [
        {
          id: 1,
          title: 'Air - Moon Safari',
          year: 1998,
          catno: 'MOVLP2464',
          barcode: ['0 81227 97108 3', '081227971083', 'none'],
          master_id: 12345,
          label: ['Music On Vinyl'],
          country: 'Europe',
          format: ['Vinyl', 'LP', 'Album', 'Reissue'],
        },
      ],
      pagination: { page: 1, pages: 1 },
    });

    const res = await svc.search('moon safari', { userId: USER, limit: 10 });

    expect(res.items[0].metadata).toMatchObject({
      catno: 'MOVLP2464',
      // Digits only + dédupliqué : comparable à un EAN scanné. "none" (< 6 digits) est écarté.
      barcodes: ['081227971083'],
      masterId: '12345',
      label: ['Music On Vinyl'],
      country: 'Europe',
    });
    expect(res.items[0].releaseDate).toBe('1998-01-01');
  });

  it('résultat sans catno/barcode/master : les champs restent absents (pas de null bruyant)', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      results: [{ id: 2, title: 'Degiheugi - Endless Smile' }],
      pagination: { page: 1, pages: 1 },
    });

    const res = await svc.search('degiheugi', { userId: USER, limit: 10 });

    expect(res.items[0].metadata).toMatchObject({
      catno: undefined,
      barcodes: undefined,
      masterId: undefined,
    });
  });

  it('multi-artistes : split sur " / " et strip du suffixe d\'homonymie " (N)"', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      results: [
        { id: 3, title: 'Bob Dylan / The Band (2) - Before The Flood' },
      ],
      pagination: { page: 1, pages: 1 },
    });

    const res = await svc.search('before the flood', {
      userId: USER,
      limit: 10,
    });

    expect(res.items[0].creators).toEqual(['Bob Dylan', 'The Band']);
    expect(res.items[0].title).toBe('Before The Flood');
  });

  it('titre contenant un tiret : le split se fait au PREMIER " - "', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      results: [{ id: 4, title: 'Various - Rock - The Early Years' }],
      pagination: { page: 1, pages: 1 },
    });

    const res = await svc.search('rock', { userId: USER, limit: 10 });

    expect(res.items[0].creators).toEqual(['Various']);
    expect(res.items[0].title).toBe('Rock - The Early Years');
  });

  it('famille de cache : `q` et `barcode` sont mesurés séparément (pression quota)', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      results: [],
      pagination: { page: 1, pages: 1 },
    });

    await svc.search('jazz', { userId: USER, limit: 10 });
    await svc.searchByBarcode('0081227971083', { userId: USER, limit: 10 });

    expect(deps.cache.getOrFetch.mock.calls[0][3]).toBe('discogs:search:q');
    expect(deps.cache.getOrFetch.mock.calls[1][3]).toBe(
      'discogs:search:barcode',
    );
  });

  it('jeton user résolu : enfile le job (le worker signera) sans appel direct', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: {
        accessToken: 'user-access',
        refreshToken: 'user-secret',
        expiresAtMs: 0,
        scopes: [],
      },
    });
    deps.waitUntilFinished.mockResolvedValue({
      results: [],
      pagination: { page: 1, pages: 1 },
    });

    await svc.search('x', { userId: USER, limit: 10 });

    expect(deps.queue.add).toHaveBeenCalledTimes(1);
    // Le payload ne contient AUCUN secret (ni token user, ni consumer) — juste userId + URL.
    const [, payload] = deps.queue.add.mock.calls[0];
    expect(JSON.stringify(payload)).not.toContain('user-access');
    expect(JSON.stringify(payload)).not.toContain('user-secret');
  });

  it('repli premium (fallback) sans aucun credential serveur : ServiceUnavailable, aucun enqueue', async () => {
    const { deps, svc } = makeDeps({
      DISCOGS_CONSUMER_KEY: undefined,
      DISCOGS_CONSUMER_SECRET: undefined,
      DISCOGS_ACERVATIM_TOKEN: undefined,
    });
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });

    await expect(
      svc.search('x', { userId: USER, limit: 10 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(deps.queue.add).not.toHaveBeenCalled();
  });

  it('circuit-breaker : Redis indisponible → 503 immédiat, aucun enqueue', async () => {
    const { deps, svc } = makeDeps();
    deps.redisHealth.isAvailable.mockReturnValue(false);

    await expect(
      svc.search('x', { userId: USER, limit: 10 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(deps.queue.add).not.toHaveBeenCalled();
  });

  it('mode dégradé (none) sans cache : SourceTokenRequired 403, aucun enqueue', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'none' });
    deps.cache.get.mockResolvedValue(null);

    await expect(
      svc.search('x', { userId: USER, limit: 10 }),
    ).rejects.toBeInstanceOf(SourceTokenRequiredException);
    expect(deps.queue.add).not.toHaveBeenCalled();
  });

  it('mode dégradé (none) avec hit de cache partagé : sert le cache sans enqueue', async () => {
    const { deps, svc } = makeDeps();
    deps.tokenResolver.resolve.mockResolvedValue({ source: 'none' });
    deps.cache.get.mockResolvedValue({
      results: [{ id: 5, title: 'Air - Moon Safari' }],
      pagination: { page: 1, pages: 1 },
    });

    const res = await svc.search('air', { userId: USER, limit: 10 });

    expect(deps.queue.add).not.toHaveBeenCalled();
    expect(res.items[0].sourceId).toBe('5');
  });

  it('clé de cache search partagée (provider:mode, SANS userId) — repli/dégradé mutualisables', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      results: [],
      pagination: { page: 1, pages: 1 },
    });

    await svc.search('jazz', { userId: USER, limit: 10 });

    const cacheKey = deps.cache.getOrFetch.mock.calls[0][0] as string;
    expect(cacheKey).toBe('discogs:search:q:jazz:1:10');
    expect(cacheKey).not.toContain(USER);
  });
});

describe('DiscogsAdapter.searchByBarcode', () => {
  it('interroge Discogs avec le paramètre `barcode=` (pas `q=`)', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      results: [],
      pagination: { page: 1, pages: 1 },
    });

    await svc.searchByBarcode('0888072024557', { userId: USER, limit: 50 });

    const [, payload] = deps.queue.add.mock.calls[0];
    expect(payload.url).toContain('barcode=0888072024557');
    expect(payload.url).toContain('type=release');
    expect(payload.url).not.toContain('q=');
  });

  it('mappe les résultats vers UnifiedItem comme la recherche texte', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      results: [{ id: 7, title: 'Daft Punk - Discovery', year: 2001 }],
      pagination: { page: 1, pages: 1 },
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
      title: 'Discovery',
      creators: ['Daft Punk'],
    });
  });

  it('garde le titre tel quel quand il ne contient pas de separateur " - "', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      results: [{ id: 8, title: 'Untitled', year: 2020 }],
      pagination: { page: 1, pages: 1 },
    });

    const res = await svc.search('untitled', { userId: USER, limit: 50 });

    expect(res.items[0]).toMatchObject({ title: 'Untitled', creators: [] });
  });
});

describe('DiscogsAdapter.fetchDetails', () => {
  it('mappe artists + images + released vers UnifiedItem', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      id: 42,
      title: 'Kind of Blue',
      released: '1959-08-17',
      artists: [{ name: 'Miles Davis' }, { name: 'John Coltrane' }],
      images: [
        { uri: 'https://img/full.jpg', uri150: 'https://img/thumb.jpg' },
      ],
      formats: [{ name: 'Vinyl', descriptions: ['LP', 'Album', '33 ⅓ RPM'] }],
      genres: ['Jazz'],
      styles: ['Modal', 'Cool Jazz'],
      labels: [{ name: 'Columbia' }],
      country: 'US',
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
      genres: ['Jazz'],
      styles: ['Modal', 'Cool Jazz'],
      recordingSpeed: 'RPM_33',
      labels: ['Columbia'],
      country: 'US',
    });
  });

  it('dérive recordingSpeed=45 depuis les descriptions du format', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      id: 43,
      title: 'Single',
      formats: [{ name: 'Vinyl', descriptions: ['7"', 'Single', '45 RPM'] }],
    });

    const item = await svc.fetchDetails('43', { userId: USER, limit: 50 });
    expect(item.metadata).toMatchObject({ recordingSpeed: 'RPM_45' });
  });

  it('recordingSpeed undefined pour un format sans vitesse (ex. CD)', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      id: 44,
      title: 'Album CD',
      formats: [{ name: 'CD', descriptions: ['Album'] }],
    });

    const item = await svc.fetchDetails('44', { userId: USER, limit: 50 });
    expect(item.metadata?.recordingSpeed).toBeUndefined();
  });

  it('multi-auteurs : prefere anv, strip le suffixe homonyme " (N)"', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      id: 100,
      title: 'Split',
      artists: [
        { name: 'Artiste1' },
        { name: 'Nirvana (2)' },
        { name: 'The Beatles', anv: 'Beatles' },
      ],
    });

    const item = await svc.fetchDetails('100', { userId: USER, limit: 50 });

    expect(item.creators).toEqual(['Artiste1', 'Nirvana', 'Beatles']);
  });

  it('extrait le barcode depuis identifiers (type "Barcode", digits only)', async () => {
    const { deps, svc } = makeDeps();
    deps.waitUntilFinished.mockResolvedValue({
      id: 99,
      title: 'Discovery',
      identifiers: [
        { type: 'Barcode', value: '0 888072 024557', description: 'Text' },
        { type: 'Matrix / Runout', value: 'ABC-123' },
      ],
    });

    const item = await svc.fetchDetails('99', { userId: USER, limit: 50 });

    expect(item.metadata).toMatchObject({ barcode: '0888072024557' });
  });
});
