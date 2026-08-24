import { PrismaService } from '../../prisma/prisma.service';
import { ApiCacheService } from './api-cache.service';

type PrismaMock = {
  apiCache: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    deleteMany: jest.Mock;
  };
};

function makePrismaMock(): PrismaMock {
  return {
    apiCache: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
}

describe('ApiCacheService.getOrFetch', () => {
  it('hit non expiré → ne fetch pas', async () => {
    const prisma = makePrismaMock();
    const future = new Date(Date.now() + 60_000);
    prisma.apiCache.findUnique.mockResolvedValue({
      cacheKey: 'k',
      payload: { cached: true },
      expiresAt: future,
    });
    const svc = new ApiCacheService(prisma as unknown as PrismaService);
    const fetcher = jest.fn();

    const res = await svc.getOrFetch('k', 60, fetcher);
    expect(res).toEqual({ cached: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(prisma.apiCache.upsert).not.toHaveBeenCalled();
  });

  it('miss → fetch + upsert avec TTL', async () => {
    const prisma = makePrismaMock();
    prisma.apiCache.findUnique.mockResolvedValue(null);
    const svc = new ApiCacheService(prisma as unknown as PrismaService);
    const fetcher = jest.fn().mockResolvedValue({ fresh: true });

    const res = await svc.getOrFetch('k', 60, fetcher);
    expect(res).toEqual({ fresh: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(prisma.apiCache.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.apiCache.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ cacheKey: 'k' });
    expect(call.create.payload).toEqual({ fresh: true });
  });

  it('hit expiré → fetch + upsert (refresh)', async () => {
    const prisma = makePrismaMock();
    const past = new Date(Date.now() - 60_000);
    prisma.apiCache.findUnique.mockResolvedValue({
      cacheKey: 'k',
      payload: { stale: true },
      expiresAt: past,
    });
    const svc = new ApiCacheService(prisma as unknown as PrismaService);
    const fetcher = jest.fn().mockResolvedValue({ fresh: true });

    const res = await svc.getOrFetch('k', 60, fetcher);
    expect(res).toEqual({ fresh: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(prisma.apiCache.upsert).toHaveBeenCalledTimes(1);
  });

  it('deux appels successifs miss/hit → 1 seul fetch (sprint DoD)', async () => {
    const prisma = makePrismaMock();
    const svc = new ApiCacheService(prisma as unknown as PrismaService);

    // 1er appel : miss → on persiste.
    prisma.apiCache.findUnique.mockResolvedValueOnce(null);
    let persisted: { payload: unknown; expiresAt: Date } | null = null;
    prisma.apiCache.upsert.mockImplementation(async ({ create }) => {
      persisted = { payload: create.payload, expiresAt: create.expiresAt };
    });
    const fetcher = jest.fn().mockResolvedValue({ x: 1 });
    await svc.getOrFetch('k', 60, fetcher);

    // 2ème appel : on simule un hit avec ce qu'on a persisté.
    prisma.apiCache.findUnique.mockResolvedValueOnce({
      cacheKey: 'k',
      payload: persisted!.payload,
      expiresAt: persisted!.expiresAt,
    });
    await svc.getOrFetch('k', 60, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fetcher qui throw → erreur remonte, rien en cache', async () => {
    const prisma = makePrismaMock();
    prisma.apiCache.findUnique.mockResolvedValue(null);
    const svc = new ApiCacheService(prisma as unknown as PrismaService);
    const fetcher = jest.fn().mockRejectedValue(new Error('upstream'));

    await expect(svc.getOrFetch('k', 60, fetcher)).rejects.toThrow('upstream');
    expect(prisma.apiCache.upsert).not.toHaveBeenCalled();
  });
});

describe('ApiCacheService.stats (SD1 — mesurer le taux de hit par famille)', () => {
  it('sépare les familles déclarées et calcule le hitRate', async () => {
    const prisma = makePrismaMock();
    const svc = new ApiCacheService(prisma as unknown as PrismaService);
    const future = new Date(Date.now() + 60_000);

    // barcode : 1 miss puis 1 hit (clé très partagée entre utilisateurs)
    prisma.apiCache.findUnique.mockResolvedValueOnce(null);
    await svc.getOrFetch(
      'discogs:search:barcode:123:1:50',
      60,
      async () => 1,
      'discogs:search:barcode',
    );
    prisma.apiCache.findUnique.mockResolvedValueOnce({
      payload: 1,
      expiresAt: future,
    });
    await svc.getOrFetch(
      'discogs:search:barcode:123:1:50',
      60,
      async () => 1,
      'discogs:search:barcode',
    );

    // texte : 2 miss (requêtes libres, donc rarement identiques)
    prisma.apiCache.findUnique.mockResolvedValue(null);
    await svc.getOrFetch(
      'discogs:search:q:degiheugi:1:50',
      60,
      async () => 1,
      'discogs:search:q',
    );
    await svc.getOrFetch(
      'discogs:search:q:air moon:1:50',
      60,
      async () => 1,
      'discogs:search:q',
    );

    const stats = svc.stats();
    expect(stats).toEqual(
      expect.arrayContaining([
        { family: 'discogs:search:barcode', hits: 1, misses: 1, hitRate: 0.5 },
        { family: 'discogs:search:q', hits: 0, misses: 2, hitRate: 0 },
      ]),
    );
  });

  it('sans famille déclarée, retombe sur le provider (cardinal borné)', async () => {
    const prisma = makePrismaMock();
    prisma.apiCache.findUnique.mockResolvedValue(null);
    const svc = new ApiCacheService(prisma as unknown as PrismaService);

    await svc.getOrFetch('gbooks:cover:9782413047070', 60, async () => 1);
    await svc.getOrFetch('gbooks:cover:9791032706343', 60, async () => 1);

    expect(svc.stats()).toEqual([
      { family: 'gbooks', hits: 0, misses: 2, hitRate: 0 },
    ]);
  });

  it('`get` ne compte que si une famille est déclarée (les pendings OAuth ne polluent pas)', async () => {
    const prisma = makePrismaMock();
    prisma.apiCache.findUnique.mockResolvedValue(null);
    const svc = new ApiCacheService(prisma as unknown as PrismaService);

    await svc.get('oauth-discogs-pending:abc');
    expect(svc.stats()).toEqual([]);

    await svc.get('discogs:search:q:air:1:50', 'discogs:search:q');
    expect(svc.stats()).toEqual([
      { family: 'discogs:search:q', hits: 0, misses: 1, hitRate: 0 },
    ]);
  });
});

describe('ApiCacheService.pruneExpired', () => {
  it('deleteMany sur expiresAt < now', async () => {
    const prisma = makePrismaMock();
    prisma.apiCache.deleteMany.mockResolvedValue({ count: 3 });
    const svc = new ApiCacheService(prisma as unknown as PrismaService);
    const res = await svc.pruneExpired();
    expect(res).toBe(3);
    const call = prisma.apiCache.deleteMany.mock.calls[0][0];
    expect(call.where.expiresAt.lt).toBeInstanceOf(Date);
  });
});
