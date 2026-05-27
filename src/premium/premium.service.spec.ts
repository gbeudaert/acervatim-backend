import { PrismaService } from '../prisma/prisma.service';
import { PremiumService } from './premium.service';

type PrismaMock = {
  premiumGrant: { findUnique: jest.Mock };
  subscription: { findUnique: jest.Mock };
};

function makePrismaMock(): PrismaMock {
  return {
    premiumGrant: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
  };
}

function makeService(prisma: PrismaMock): PremiumService {
  return new PremiumService(prisma as unknown as PrismaService);
}

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const FUTURE = BigInt(Date.now() + 24 * 3600_000);
const PAST = BigInt(Date.now() - 24 * 3600_000);

describe('PremiumService.getStatus — grant', () => {
  it('grant permanent (expiresAt null) → premium grant, expiresAt null', async () => {
    const prisma = makePrismaMock();
    prisma.premiumGrant.findUnique.mockResolvedValue({
      userId: USER,
      reason: 'beta_tester',
      expiresAt: null,
    });
    prisma.subscription.findUnique.mockResolvedValue(null);

    await expect(makeService(prisma).getStatus(USER)).resolves.toEqual({
      isPremium: true,
      source: 'grant',
      expiresAt: null,
    });
  });

  it('grant futur → premium grant avec expiresAt converti en number', async () => {
    const prisma = makePrismaMock();
    prisma.premiumGrant.findUnique.mockResolvedValue({
      userId: USER,
      reason: 'comp',
      expiresAt: FUTURE,
    });
    prisma.subscription.findUnique.mockResolvedValue(null);

    const status = await makeService(prisma).getStatus(USER);
    expect(status.isPremium).toBe(true);
    expect(status.source).toBe('grant');
    expect(status.expiresAt).toBe(Number(FUTURE));
    expect(typeof status.expiresAt).toBe('number');
  });

  it('grant expiré → ignoré, retombe sur sub si présente', async () => {
    const prisma = makePrismaMock();
    prisma.premiumGrant.findUnique.mockResolvedValue({
      userId: USER,
      reason: 'comp',
      expiresAt: PAST,
    });
    prisma.subscription.findUnique.mockResolvedValue({
      userId: USER,
      status: 'active',
      expiresAt: FUTURE,
    });

    await expect(makeService(prisma).getStatus(USER)).resolves.toMatchObject({
      isPremium: true,
      source: 'subscription',
    });
  });

  it('grant actif prioritaire sur sub active (priorité grant)', async () => {
    const prisma = makePrismaMock();
    prisma.premiumGrant.findUnique.mockResolvedValue({
      userId: USER,
      reason: 'beta_tester',
      expiresAt: null,
    });
    prisma.subscription.findUnique.mockResolvedValue({
      userId: USER,
      status: 'active',
      expiresAt: FUTURE,
    });

    await expect(makeService(prisma).getStatus(USER)).resolves.toMatchObject({
      source: 'grant',
    });
  });
});

describe('PremiumService.getStatus — subscription', () => {
  it.each([['active'], ['grace_period'], ['cancelled']])(
    'status=%s + expiresAt futur → premium subscription',
    async (status) => {
      const prisma = makePrismaMock();
      prisma.premiumGrant.findUnique.mockResolvedValue(null);
      prisma.subscription.findUnique.mockResolvedValue({
        userId: USER,
        status,
        expiresAt: FUTURE,
      });

      await expect(makeService(prisma).getStatus(USER)).resolves.toEqual({
        isPremium: true,
        source: 'subscription',
        expiresAt: Number(FUTURE),
      });
    },
  );

  it.each([['expired'], ['on_hold'], ['paused']])(
    'status=%s → pas premium même avec expiresAt futur',
    async (status) => {
      const prisma = makePrismaMock();
      prisma.premiumGrant.findUnique.mockResolvedValue(null);
      prisma.subscription.findUnique.mockResolvedValue({
        userId: USER,
        status,
        expiresAt: FUTURE,
      });

      await expect(makeService(prisma).getStatus(USER)).resolves.toEqual({
        isPremium: false,
        source: 'none',
        expiresAt: null,
      });
    },
  );

  it('status=active mais expiresAt passé → pas premium', async () => {
    const prisma = makePrismaMock();
    prisma.premiumGrant.findUnique.mockResolvedValue(null);
    prisma.subscription.findUnique.mockResolvedValue({
      userId: USER,
      status: 'active',
      expiresAt: PAST,
    });

    await expect(makeService(prisma).getStatus(USER)).resolves.toMatchObject({
      isPremium: false,
      source: 'none',
    });
  });
});

describe('PremiumService.getStatus — none', () => {
  it('ni grant ni sub → not premium', async () => {
    const prisma = makePrismaMock();
    prisma.premiumGrant.findUnique.mockResolvedValue(null);
    prisma.subscription.findUnique.mockResolvedValue(null);

    await expect(makeService(prisma).getStatus(USER)).resolves.toEqual({
      isPremium: false,
      source: 'none',
      expiresAt: null,
    });
  });

  it('lookups exécutés en parallèle (Promise.all)', async () => {
    const prisma = makePrismaMock();
    prisma.premiumGrant.findUnique.mockResolvedValue(null);
    prisma.subscription.findUnique.mockResolvedValue(null);

    await makeService(prisma).getStatus(USER);

    expect(prisma.premiumGrant.findUnique).toHaveBeenCalledWith({
      where: { userId: USER },
    });
    expect(prisma.subscription.findUnique).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });
});
