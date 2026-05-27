import { PrismaService } from '../../prisma/prisma.service';
import { TokenBucketService } from './token-bucket.service';

type PrismaMock = {
  rateLimitBucket: {
    findUnique: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
};

function makePrismaMock(): PrismaMock {
  return {
    rateLimitBucket: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
}

/**
 * In-memory store qui simule la sémantique CAS de updateMany sur lastRefill.
 * Suffit pour tester 60 consume successifs + le 61ème.
 */
function makeStatefulPrisma(): PrismaMock {
  const prisma = makePrismaMock();
  let row: { tokens: number; lastRefill: bigint; expiresAt: Date } | null =
    null;

  prisma.rateLimitBucket.findUnique.mockImplementation(async () => {
    if (!row) return null;
    return { ...row };
  });
  prisma.rateLimitBucket.create.mockImplementation(async ({ data }) => {
    row = {
      tokens: data.tokens,
      lastRefill: data.lastRefill,
      expiresAt: data.expiresAt,
    };
    return row;
  });
  prisma.rateLimitBucket.updateMany.mockImplementation(
    async ({ where, data }) => {
      if (!row || row.lastRefill !== where.lastRefill) return { count: 0 };
      row = {
        tokens: data.tokens,
        lastRefill: data.lastRefill,
        expiresAt: data.expiresAt,
      };
      return { count: 1 };
    },
  );
  return prisma;
}

describe('TokenBucketService.consume', () => {
  beforeEach(() => {
    // Time figé pour exclure tout refill pendant la rafale.
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('60 appels successifs sur capacity=60 passent, le 61ème échoue (DoD sprint)', async () => {
    const prisma = makeStatefulPrisma();
    const svc = new TokenBucketService(prisma as unknown as PrismaService);

    for (let i = 1; i <= 60; i++) {
      const ok = await svc.consume('user:abc:discogs', 60, 1);
      expect(ok).toBe(true);
    }
    const denied = await svc.consume('user:abc:discogs', 60, 1);
    expect(denied).toBe(false);
  });

  it('après refill (1s avec refill=1/s sur capacity=60), un appel passe à nouveau', async () => {
    const prisma = makeStatefulPrisma();
    const svc = new TokenBucketService(prisma as unknown as PrismaService);

    for (let i = 0; i < 60; i++) await svc.consume('k', 60, 1);
    expect(await svc.consume('k', 60, 1)).toBe(false);

    jest.advanceTimersByTime(1100);
    expect(await svc.consume('k', 60, 1)).toBe(true);
  });

  it('refill cappé à capacity (un bucket inactif depuis longtemps ne dépasse pas)', async () => {
    const prisma = makeStatefulPrisma();
    const svc = new TokenBucketService(prisma as unknown as PrismaService);

    // 1er consume pour créer le bucket à capacity-1.
    await svc.consume('k', 60, 1);
    // 1 heure plus tard → refill théorique = 3600, mais clampé à 60.
    jest.advanceTimersByTime(3600 * 1000);
    for (let i = 0; i < 60; i++) {
      expect(await svc.consume('k', 60, 1)).toBe(true);
    }
    expect(await svc.consume('k', 60, 1)).toBe(false);
  });
});

describe('TokenBucketService.consume — CAS race', () => {
  it('si create P2002 (race), retente comme update', async () => {
    const prisma = makePrismaMock();
    let createCalled = 0;
    // Premier findUnique : null. Le create throw P2002. Deuxième findUnique : la ligne créée par le rival.
    prisma.rateLimitBucket.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        tokens: 59,
        lastRefill: BigInt(Date.now()),
        expiresAt: new Date(),
      });
    prisma.rateLimitBucket.create.mockImplementation(async () => {
      createCalled += 1;
      const err = Object.assign(new Error('dup'), {
        code: 'P2002',
        clientVersion: 'test',
      });
      // Doit ressembler à un PrismaClientKnownRequestError → on triche le prototype.
      Object.setPrototypeOf(
        err,
        require('@prisma/client').Prisma.PrismaClientKnownRequestError
          .prototype,
      );
      throw err;
    });
    prisma.rateLimitBucket.updateMany.mockResolvedValue({ count: 1 });

    const svc = new TokenBucketService(prisma as unknown as PrismaService);
    const ok = await svc.consume('k', 60, 1);
    expect(ok).toBe(true);
    expect(createCalled).toBe(1);
    expect(prisma.rateLimitBucket.updateMany).toHaveBeenCalledTimes(1);
  });
});
