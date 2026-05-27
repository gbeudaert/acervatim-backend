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
