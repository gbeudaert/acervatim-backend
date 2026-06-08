import { PremiumService, PremiumStatus } from '../../premium/premium.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QuotaExceededException } from './quota-exceeded.exception';
import { FREE_TIER_LIMITS, QuotaService } from './quota.service';

type PrismaMock = {
  collection: {
    count: jest.Mock;
    aggregate: jest.Mock;
  };
};

function makePrismaMock(): PrismaMock {
  return {
    collection: {
      count: jest.fn(),
      aggregate: jest.fn(),
    },
  };
}

const FREE_STATUS: PremiumStatus = {
  isPremium: false,
  source: 'none',
  expiresAt: null,
};
const PREMIUM_STATUS: PremiumStatus = {
  isPremium: true,
  source: 'grant',
  expiresAt: null,
};

function makePremiumMock(status: PremiumStatus = FREE_STATUS): PremiumService {
  return {
    getStatus: jest.fn().mockResolvedValue(status),
  } as unknown as PremiumService;
}

function makeService(
  prisma: PrismaMock,
  premium: PremiumService = makePremiumMock(),
): QuotaService {
  return new QuotaService(prisma as unknown as PrismaService, premium);
}

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

describe('QuotaService.assertCanCreateCollection', () => {
  it('passe quand used < max', async () => {
    const prisma = makePrismaMock();
    prisma.collection.count.mockResolvedValue(FREE_TIER_LIMITS.collections - 1);

    await expect(
      makeService(prisma).assertCanCreateCollection(USER),
    ).resolves.toBeUndefined();
  });

  it('throw QuotaExceededException avec message "max 10" quand used == max', async () => {
    const prisma = makePrismaMock();
    prisma.collection.count.mockResolvedValue(FREE_TIER_LIMITS.collections);

    await expect(
      makeService(prisma).assertCanCreateCollection(USER),
    ).rejects.toMatchObject({
      constructor: QuotaExceededException,
      message: expect.stringContaining(`max ${FREE_TIER_LIMITS.collections}`),
    });
  });

  it('throw quand used > max (cas dégradé)', async () => {
    const prisma = makePrismaMock();
    prisma.collection.count.mockResolvedValue(FREE_TIER_LIMITS.collections + 5);

    await expect(
      makeService(prisma).assertCanCreateCollection(USER),
    ).rejects.toBeInstanceOf(QuotaExceededException);
  });

  it('scope le count par userId', async () => {
    const prisma = makePrismaMock();
    prisma.collection.count.mockResolvedValue(0);

    await makeService(prisma).assertCanCreateCollection(USER);

    expect(prisma.collection.count).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });
});

describe('QuotaService.assertCanCreateItem', () => {
  it('passe quand sum(itemCount) < max', async () => {
    const prisma = makePrismaMock();
    prisma.collection.aggregate.mockResolvedValue({
      _sum: { itemCount: FREE_TIER_LIMITS.items - 1 },
    });

    await expect(
      makeService(prisma).assertCanCreateItem(USER),
    ).resolves.toBeUndefined();
  });

  it('passe quand le user n’a aucune collection (sum null)', async () => {
    const prisma = makePrismaMock();
    prisma.collection.aggregate.mockResolvedValue({
      _sum: { itemCount: null },
    });

    await expect(
      makeService(prisma).assertCanCreateItem(USER),
    ).resolves.toBeUndefined();
  });

  it('throw quand sum(itemCount) == max', async () => {
    const prisma = makePrismaMock();
    prisma.collection.aggregate.mockResolvedValue({
      _sum: { itemCount: FREE_TIER_LIMITS.items },
    });

    await expect(
      makeService(prisma).assertCanCreateItem(USER),
    ).rejects.toMatchObject({
      constructor: QuotaExceededException,
      message: expect.stringContaining(`max ${FREE_TIER_LIMITS.items}`),
    });
  });
});

describe('QuotaService.getQuotaSummary', () => {
  it('renvoie used + max pour collections et items', async () => {
    const prisma = makePrismaMock();
    prisma.collection.count.mockResolvedValue(3);
    prisma.collection.aggregate.mockResolvedValue({ _sum: { itemCount: 42 } });

    const summary = await makeService(prisma).getQuotaSummary(USER);

    expect(summary).toEqual({
      collections: { used: 3, max: FREE_TIER_LIMITS.collections },
      items: { used: 42, max: FREE_TIER_LIMITS.items },
    });
  });

  it('items.used = 0 quand aucune collection (sum null)', async () => {
    const prisma = makePrismaMock();
    prisma.collection.count.mockResolvedValue(0);
    prisma.collection.aggregate.mockResolvedValue({
      _sum: { itemCount: null },
    });

    const summary = await makeService(prisma).getQuotaSummary(USER);

    expect(summary.items.used).toBe(0);
  });
});

describe('QuotaService — comptes premium (illimité)', () => {
  it('assertCanCreateCollection passe même au-dessus de la limite, sans compter', async () => {
    const prisma = makePrismaMock();
    const svc = makeService(prisma, makePremiumMock(PREMIUM_STATUS));

    await expect(svc.assertCanCreateCollection(USER)).resolves.toBeUndefined();
    // Sortie anticipée : aucun count DB.
    expect(prisma.collection.count).not.toHaveBeenCalled();
  });

  it('assertCanCreateItem passe même au-dessus de la limite, sans agréger', async () => {
    const prisma = makePrismaMock();
    const svc = makeService(prisma, makePremiumMock(PREMIUM_STATUS));

    await expect(svc.assertCanCreateItem(USER)).resolves.toBeUndefined();
    expect(prisma.collection.aggregate).not.toHaveBeenCalled();
  });

  it('getQuotaSummary renvoie max:null mais garde le used réel', async () => {
    const prisma = makePrismaMock();
    prisma.collection.count.mockResolvedValue(15);
    prisma.collection.aggregate.mockResolvedValue({ _sum: { itemCount: 700 } });
    const svc = makeService(prisma, makePremiumMock(PREMIUM_STATUS));

    const summary = await svc.getQuotaSummary(USER);

    expect(summary).toEqual({
      collections: { used: 15, max: null },
      items: { used: 700, max: null },
    });
  });
});
