import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TokenResolverService } from '../token-resolver.service';
import { TmdbAdapter } from './tmdb.adapter';
import { TMDB_FETCH_JOB } from './tmdb.types';

function makeDeps(apiKey: string | null = 'tmdb-key') {
  const cache = {
    getOrFetch: jest.fn(
      async (_k: string, _ttl: number, fetcher: () => Promise<unknown>) =>
        fetcher(),
    ),
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  };
  // Par défaut : repli premium (clé serveur). Les tests BYOT / dégradé surchargent `resolve`.
  const tokenResolver = {
    resolve: jest.fn().mockResolvedValue({ source: 'fallback' }),
  };
  const waitUntilFinished = jest.fn();
  const queue = { add: jest.fn().mockResolvedValue({ waitUntilFinished }) };
  const config = { get: jest.fn() };
  const svc = new TmdbAdapter(
    config as never,
    cache as unknown as ApiCacheService,
    tokenResolver as unknown as TokenResolverService,
    queue as never,
  );
  // Court-circuite onModuleInit (qui ouvrirait une connexion Redis) : on pose les champs à la main.
  (svc as unknown as { serverApiKey?: string }).serverApiKey =
    apiKey ?? undefined;
  (svc as unknown as { queueEvents: unknown }).queueEvents = {};
  return { cache, tokenResolver, queue, waitUntilFinished, svc };
}

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

describe('TmdbAdapter — config', () => {
  it('throw ServiceUnavailable si repli premium mais TMDB_API_KEY absent', async () => {
    const { svc, queue } = makeDeps(null);
    await expect(
      svc.search('q', { userId: USER, limit: 10 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('TmdbAdapter.search', () => {
  it('enfile un job (URL sans clé) et mappe la réponse du worker', async () => {
    const { queue, waitUntilFinished, svc } = makeDeps();
    waitUntilFinished.mockResolvedValue({
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
    });

    const res = await svc.search('fight club', { userId: USER, limit: 20 });

    expect(queue.add).toHaveBeenCalledWith(
      TMDB_FETCH_JOB,
      { userId: USER, url: expect.stringContaining('/search/movie') },
      // jobId = hash de la clé publique (sans ':' ni espaces, contrainte BullMQ).
      expect.objectContaining({ jobId: expect.any(String) }),
    );
    const jobData = queue.add.mock.calls[0][1] as { url: string };
    expect(jobData.url).toContain('query=fight%20club');
    expect(jobData.url).toContain('page=1');
    expect(jobData.url).not.toContain('api_key'); // clé injectée par le worker

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
    const { waitUntilFinished, svc } = makeDeps();
    waitUntilFinished.mockResolvedValue({
      page: 1,
      total_pages: 5,
      results: [],
    });
    const res = await svc.search('q', { userId: USER, limit: 20 });
    expect(res.nextCursor).toBe('2');
  });

  it('clé perso user (BYOT) : enfile aussi un job (l’injection de clé se fait dans le worker)', async () => {
    const { queue, waitUntilFinished, tokenResolver, svc } = makeDeps();
    tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: { accessToken: 'user-tmdb-key', expiresAtMs: 0, scopes: [] },
    });
    waitUntilFinished.mockResolvedValue({
      page: 1,
      total_pages: 1,
      results: [],
    });

    await svc.search('q', { userId: USER, limit: 20 });

    expect(queue.add).toHaveBeenCalledWith(
      TMDB_FETCH_JOB,
      { userId: USER, url: expect.not.stringContaining('api_key') },
      expect.any(Object),
    );
  });

  it('mode dégradé (none) sans cache : SourceTokenRequired 403, aucun enqueue', async () => {
    const { queue, tokenResolver, cache, svc } = makeDeps();
    tokenResolver.resolve.mockResolvedValue({ source: 'none' });
    cache.get.mockResolvedValue(null);

    await expect(
      svc.search('q', { userId: USER, limit: 20 }),
    ).rejects.toBeInstanceOf(SourceTokenRequiredException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('mode dégradé (none) avec hit de cache partagé : sert le cache sans enqueue', async () => {
    const { queue, tokenResolver, cache, svc } = makeDeps();
    tokenResolver.resolve.mockResolvedValue({ source: 'none' });
    cache.get.mockResolvedValue({
      page: 1,
      total_pages: 1,
      results: [{ id: 12, title: 'Cached Movie' }],
    });

    const res = await svc.search('q', { userId: USER, limit: 20 });

    expect(queue.add).not.toHaveBeenCalled();
    expect(res.items[0].sourceId).toBe('12');
  });

  it("cache key EXCLUT l'apiKey (rotation ne nuke pas le cache)", async () => {
    const { cache, waitUntilFinished, svc } = makeDeps();
    waitUntilFinished.mockResolvedValue({
      page: 1,
      total_pages: 1,
      results: [],
    });
    await svc.search('fight club', { userId: USER, limit: 20 });
    const cacheKey = cache.getOrFetch.mock.calls[0][0] as string;
    expect(cacheKey).toBe('tmdb:search:fight club:1');
  });

  it('échec du worker (TMDB indispo) → BadGateway', async () => {
    const { waitUntilFinished, svc } = makeDeps();
    waitUntilFinished.mockRejectedValue(new Error('boom'));
    await expect(
      svc.search('q', { userId: USER, limit: 20 }),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('TmdbAdapter.fetchDetails', () => {
  it('extrait les directors depuis credits.crew et mappe runtime/genres', async () => {
    const { queue, waitUntilFinished, svc } = makeDeps();
    waitUntilFinished.mockResolvedValue({
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
    });

    const item = await svc.fetchDetails('550', { userId: USER, limit: 1 });

    expect(item.creators).toEqual(['David Fincher']);
    expect(item.metadata).toMatchObject({
      runtime: 139,
      genres: ['Drama'],
      cast: ['Brad Pitt', 'Edward Norton'],
    });
    const jobData = queue.add.mock.calls[0][1] as { url: string };
    expect(jobData.url).toContain('/movie/550');
    expect(jobData.url).toContain('append_to_response=credits');
    expect(jobData.url).not.toContain('api_key');
  });
});
