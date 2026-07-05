import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { HttpClientService } from '../../common/http/http-client.service';
import { TokenBucketService } from '../../common/rate-limit/token-bucket.service';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TokenResolverService } from '../token-resolver.service';
import { TmdbAdapter } from './tmdb.adapter';

function makeConfig(apiKey: string | null): ConfigService {
  return {
    get: jest.fn((k: string) =>
      k === 'TMDB_API_KEY' ? (apiKey ?? undefined) : undefined,
    ),
  } as unknown as ConfigService;
}

function makeDeps(apiKey: string | null = 'tmdb-key') {
  const http = { request: jest.fn() };
  const cache = {
    getOrFetch: jest.fn(
      async (_k: string, _ttl: number, fetcher: () => Promise<unknown>) =>
        fetcher(),
    ),
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  };
  const bucket = { consume: jest.fn().mockResolvedValue(true) };
  // Par défaut : repli premium (clé serveur TMDB_API_KEY) — les tests de clé perso
  // ou de mode dégradé surchargent explicitement `resolve`.
  const tokenResolver = {
    resolve: jest.fn().mockResolvedValue({ source: 'fallback' }),
  };
  const svc = new TmdbAdapter(
    makeConfig(apiKey),
    http as unknown as HttpClientService,
    cache as unknown as ApiCacheService,
    bucket as unknown as TokenBucketService,
    tokenResolver as unknown as TokenResolverService,
  );
  svc.onModuleInit();
  return { http, cache, bucket, tokenResolver, svc };
}

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

describe('TmdbAdapter — config', () => {
  it('throw ServiceUnavailable si TMDB_API_KEY absent', async () => {
    const { svc } = makeDeps(null);
    await expect(
      svc.search('q', { userId: USER, limit: 10 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('TmdbAdapter.search', () => {
  it('appelle /search/movie avec api_key + query + page, mappe vers UnifiedItem', async () => {
    const { http, bucket, svc } = makeDeps();
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        page: 1,
        total_pages: 1,
        results: [
          {
            id: 550,
            title: 'Fight Club',
            release_date: '1999-10-15',
            overview: 'A ticking-time-bomb insomniac…',
            poster_path: '/poster.jpg',
            vote_average: 8.4,
          },
        ],
      },
    });

    const res = await svc.search('fight club', { userId: USER, limit: 20 });

    expect(bucket.consume).toHaveBeenCalledWith('tmdb:global', 200, 20);
    const url = http.request.mock.calls[0][0];
    expect(url).toContain('/search/movie');
    expect(url).toContain('api_key=tmdb-key');
    expect(url).toContain('query=fight%20club');
    expect(url).toContain('page=1');

    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      source: 'tmdb',
      sourceId: '550',
      mediaType: 'movie',
      title: 'Fight Club',
      releaseDate: '1999-10-15',
      coverUrl: 'https://image.tmdb.org/t/p/w500/poster.jpg',
    });
    expect(res.nextCursor).toBeNull();
  });

  it('renvoie nextCursor=2 quand total_pages > page', async () => {
    const { http, svc } = makeDeps();
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { page: 1, total_pages: 5, results: [] },
    });
    const res = await svc.search('q', { userId: USER, limit: 20 });
    expect(res.nextCursor).toBe('2');
  });

  it("bucket key 'tmdb:global' (pas user-scopé car pas d'OAuth user)", async () => {
    const { bucket, svc, http } = makeDeps();
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { page: 1, total_pages: 1, results: [] },
    });
    await svc.search('x', { userId: USER, limit: 20 });
    const otherUser = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    await svc.search('x', { userId: otherUser, limit: 20 });
    // Le bucket par-requête est global (une conso par recherche, même clé pour les
    // deux users) — indépendamment du bucket de repli acervatim:tmdb.
    const globalCalls = bucket.consume.mock.calls.filter(
      (c) => c[0] === 'tmdb:global',
    );
    expect(globalCalls).toHaveLength(2);
  });

  it('repli premium (fallback) : consomme le bucket partagé acervatim:tmdb', async () => {
    const { bucket, http, svc } = makeDeps();
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { page: 1, total_pages: 1, results: [] },
    });

    await svc.search('q', { userId: USER, limit: 20 });

    expect(bucket.consume).toHaveBeenCalledWith('acervatim:tmdb', 200, 20);
  });

  it('throw 429 si bucket plein', async () => {
    const { bucket, svc } = makeDeps();
    bucket.consume.mockResolvedValue(false);
    const p = svc.search('x', { userId: USER, limit: 20 });
    await expect(p).rejects.toBeInstanceOf(HttpException);
    await p.catch((e) => expect(e.getStatus()).toBe(429));
  });

  it('clé perso user (BYOT) : interroge TMDB avec la clé de l’utilisateur', async () => {
    const { http, tokenResolver, svc } = makeDeps();
    tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: { accessToken: 'user-tmdb-key', expiresAtMs: 0, scopes: [] },
    });
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { page: 1, total_pages: 1, results: [] },
    });

    await svc.search('q', { userId: USER, limit: 20 });

    const url = http.request.mock.calls[0][0];
    expect(url).toContain('api_key=user-tmdb-key');
  });

  it('mode dégradé (none) sans cache : SourceTokenRequired 403, aucun appel sortant', async () => {
    const { http, tokenResolver, cache, svc } = makeDeps();
    tokenResolver.resolve.mockResolvedValue({ source: 'none' });
    cache.get.mockResolvedValue(null);

    await expect(
      svc.search('q', { userId: USER, limit: 20 }),
    ).rejects.toBeInstanceOf(SourceTokenRequiredException);
    expect(http.request).not.toHaveBeenCalled();
  });

  it('mode dégradé (none) avec hit de cache partagé : sert le cache sans appel', async () => {
    const { http, tokenResolver, cache, svc } = makeDeps();
    tokenResolver.resolve.mockResolvedValue({ source: 'none' });
    cache.get.mockResolvedValue({
      page: 1,
      total_pages: 1,
      results: [{ id: 12, title: 'Cached Movie' }],
    });

    const res = await svc.search('q', { userId: USER, limit: 20 });

    expect(http.request).not.toHaveBeenCalled();
    expect(res.items[0].sourceId).toBe('12');
  });

  it("cache key EXCLUT l'apiKey (rotation ne nuke pas le cache)", async () => {
    const { cache, http, svc } = makeDeps();
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: { page: 1, total_pages: 1, results: [] },
    });
    await svc.search('fight club', { userId: USER, limit: 20 });
    const cacheKey = cache.getOrFetch.mock.calls[0][0] as string;
    expect(cacheKey).not.toContain('tmdb-key');
    expect(cacheKey).toBe('tmdb:search:fight club:1');
  });
});

describe('TmdbAdapter.fetchDetails', () => {
  it('extrait les directors depuis credits.crew et mappe runtime/genres', async () => {
    const { http, svc } = makeDeps();
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        id: 550,
        title: 'Fight Club',
        release_date: '1999-10-15',
        runtime: 139,
        genres: [{ id: 18, name: 'Drama' }],
        poster_path: '/p.jpg',
        credits: {
          crew: [
            { name: 'David Fincher', job: 'Director' },
            { name: 'Other Crew', job: 'Editor' },
          ],
          cast: [{ name: 'Brad Pitt' }, { name: 'Edward Norton' }],
        },
      },
    });

    const item = await svc.fetchDetails('550', { userId: USER, limit: 1 });

    expect(item.creators).toEqual(['David Fincher']);
    expect(item.metadata).toMatchObject({
      runtime: 139,
      genres: ['Drama'],
      cast: ['Brad Pitt', 'Edward Norton'],
    });
    const url = http.request.mock.calls[0][0];
    expect(url).toContain('/movie/550');
    expect(url).toContain('append_to_response=credits');
  });
});
