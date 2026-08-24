import { PrismaService } from '../../prisma/prisma.service';
import { LimitsService, TECHNICAL_LIMITS } from './limits.service';
import { TechnicalLimitException } from './technical-limit.exception';

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

type PrismaMock = {
  collection: { count: jest.Mock; aggregate: jest.Mock };
  collectionNode: { count: jest.Mock };
};

function makePrismaMock(): PrismaMock {
  return {
    collection: { count: jest.fn(), aggregate: jest.fn() },
    collectionNode: { count: jest.fn() },
  };
}

function makeService(prisma: PrismaMock): LimitsService {
  return new LimitsService(prisma as unknown as PrismaService);
}

describe('LimitsService.assertCanCreateCollection', () => {
  it('passe sous le plafond', async () => {
    const prisma = makePrismaMock();
    prisma.collection.count.mockResolvedValue(TECHNICAL_LIMITS.collections - 1);
    await expect(
      makeService(prisma).assertCanCreateCollection(USER),
    ).resolves.toBeUndefined();
  });

  it('throw TechnicalLimitException (409) quand used == max', async () => {
    const prisma = makePrismaMock();
    prisma.collection.count.mockResolvedValue(TECHNICAL_LIMITS.collections);
    await expect(
      makeService(prisma).assertCanCreateCollection(USER),
    ).rejects.toMatchObject({
      constructor: TechnicalLimitException,
      message: expect.stringContaining(`${TECHNICAL_LIMITS.collections}`),
    });
  });

  it('utilise le client transactionnel quand il est fourni (TOCTOU)', async () => {
    const prisma = makePrismaMock();
    const tx = makePrismaMock();
    tx.collection.count.mockResolvedValue(0);
    await makeService(prisma).assertCanCreateCollection(USER, tx as never);
    expect(tx.collection.count).toHaveBeenCalledTimes(1);
    expect(prisma.collection.count).not.toHaveBeenCalled();
  });
});

describe('LimitsService.assertCanCreateItem', () => {
  it('passe sous le plafond', async () => {
    const prisma = makePrismaMock();
    prisma.collection.aggregate.mockResolvedValue({
      _sum: { itemCount: TECHNICAL_LIMITS.items - 1 },
    });
    await expect(
      makeService(prisma).assertCanCreateItem(USER),
    ).resolves.toBeUndefined();
  });

  it('traite une somme nulle (aucune collection) comme 0', async () => {
    const prisma = makePrismaMock();
    prisma.collection.aggregate.mockResolvedValue({
      _sum: { itemCount: null },
    });
    await expect(
      makeService(prisma).assertCanCreateItem(USER),
    ).resolves.toBeUndefined();
  });

  it('throw TechnicalLimitException quand used == max', async () => {
    const prisma = makePrismaMock();
    prisma.collection.aggregate.mockResolvedValue({
      _sum: { itemCount: TECHNICAL_LIMITS.items },
    });
    await expect(
      makeService(prisma).assertCanCreateItem(USER),
    ).rejects.toBeInstanceOf(TechnicalLimitException);
  });
});

describe('LimitsService.assertCanCreateNode', () => {
  it('passe sous le plafond', async () => {
    const prisma = makePrismaMock();
    prisma.collectionNode.count.mockResolvedValue(TECHNICAL_LIMITS.nodes - 1);
    await expect(
      makeService(prisma).assertCanCreateNode(USER),
    ).resolves.toBeUndefined();
  });

  it('throw TechnicalLimitException quand used == max', async () => {
    const prisma = makePrismaMock();
    prisma.collectionNode.count.mockResolvedValue(TECHNICAL_LIMITS.nodes);
    await expect(
      makeService(prisma).assertCanCreateNode(USER),
    ).rejects.toBeInstanceOf(TechnicalLimitException);
  });

  it('compte les noeuds de tout le compte, pas ceux d une collection', async () => {
    const prisma = makePrismaMock();
    prisma.collectionNode.count.mockResolvedValue(0);
    await makeService(prisma).assertCanCreateNode(USER);
    expect(prisma.collectionNode.count).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });
});

describe('LimitsService — le plafond ne depend pas du palier', () => {
  it("ne consulte jamais le statut premium : c'est un garde-fou technique, pas une limite d'offre", () => {
    // Garde-fou de conception : si quelqu'un reinjecte PremiumService ici, le plafond
    // redeviendrait une limite de palier — exactement ce que S2 a supprime.
    expect(LimitsService.length).toBe(1); // seul PrismaService est injecte
  });
});
