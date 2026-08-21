import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LimitsService } from '../common/limits/limits.service';
import { SourceSnapshotService } from '../common/sources/source-snapshot.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateItemDto } from './dto/create-item.dto';
import { ItemsService } from './items.service';

type PrismaMock = {
  collection: { findFirst: jest.Mock; update: jest.Mock };
  collectionNode: {
    create: jest.Mock;
    findUnique: jest.Mock;
    delete: jest.Mock;
  };
  item: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
  };
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
};

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    collection: { findFirst: jest.fn(), update: jest.fn() },
    collectionNode: {
      create: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    item: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((arg) =>
      typeof arg === 'function' ? arg(mock) : Promise.resolve(arg),
    ),
    $queryRaw: jest.fn(),
  };
  return mock;
}

function makeLimits(): LimitsService {
  return {
    assertCanCreateCollection: jest.fn(),
    assertCanCreateItem: jest.fn().mockResolvedValue(undefined),
  } as unknown as LimitsService;
}

function makeSnapshots(): SourceSnapshotService {
  return {
    hasAdapter: jest.fn().mockReturnValue(false),
    snapshot: jest.fn(),
  } as unknown as SourceSnapshotService;
}

function makeService(
  prisma: PrismaMock,
  limits: LimitsService = makeLimits(),
  snapshots: SourceSnapshotService = makeSnapshots(),
): {
  svc: ItemsService;
  limits: LimitsService;
  snapshots: SourceSnapshotService;
} {
  const svc = new ItemsService(
    prisma as unknown as PrismaService,
    limits,
    snapshots,
  );
  return { svc, limits, snapshots };
}

const USER_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const COLL_ID = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const ITEM_ID = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee';
const NODE_ID = 'ffffffff-ffff-4fff-ffff-ffffffffffff';

// Collection vinyl (type plat) : pas de node/volume.
const VINYL_COLL = { id: COLL_ID, type: { code: 'vinyl' } };
const DTO: CreateItemDto = {
  unifiedData: { title: 'Hollow Knight OST' },
} as CreateItemDto;

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    collectionId: COLL_ID,
    userId: USER_A,
    nodeId: null,
    volume: null,
    unifiedData: { type: 'vinyl', title: 'Hollow Knight OST' },
    userData: {},
    sources: [],
    createdAt: new Date('2026-05-20T00:00:00.000Z'),
    updatedAt: new Date('2026-05-20T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ItemsService.create', () => {
  it('throw NotFound (jamais 403) si la collection appartient à un autre user', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(null);

    const { svc } = makeService(prisma);
    await expect(svc.create(USER_B, COLL_ID, DTO)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.item.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('appelle assertCanCreateItem AVEC le tx (TOCTOU réduit)', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(VINYL_COLL);
    prisma.item.create.mockResolvedValue(itemRow());
    prisma.collection.update.mockResolvedValue({});

    const limits = makeLimits();
    const { svc } = makeService(prisma, limits);
    await svc.create(USER_A, COLL_ID, DTO);

    expect(limits.assertCanCreateItem).toHaveBeenCalledWith(USER_A, prisma);
  });

  it('crée l’item ET incrémente itemCount dans la même $transaction, renvoie le curé', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(VINYL_COLL);
    prisma.item.create.mockResolvedValue(itemRow());
    prisma.collection.update.mockResolvedValue({});

    const { svc } = makeService(prisma);
    const item = await svc.create(USER_A, COLL_ID, DTO);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.item.create).toHaveBeenCalledTimes(1);
    expect(prisma.collection.update).toHaveBeenCalledWith({
      where: { id: COLL_ID },
      data: { itemCount: { increment: 1 } },
    });
    // Forme curée : sources sans rawData, type forcé dans unifiedData.
    expect(item).toMatchObject({
      id: ITEM_ID,
      nodeId: null,
      volume: null,
      unifiedData: { type: 'vinyl', title: 'Hollow Knight OST' },
      sources: [],
    });
  });

  it('force le discriminant `type` dans unifiedData à la création', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(VINYL_COLL);
    prisma.item.create.mockResolvedValue(itemRow());
    prisma.collection.update.mockResolvedValue({});

    const { svc } = makeService(prisma);
    await svc.create(USER_A, COLL_ID, {
      unifiedData: { title: 'Hollow Knight OST' },
    } as CreateItemDto);

    const data = prisma.item.create.mock.calls[0][0].data;
    expect(data.unifiedData).toMatchObject({ type: 'vinyl' });
  });

  it('persiste userData (perso) tel quel à la création, {} par défaut', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(VINYL_COLL);
    prisma.item.create.mockResolvedValue(itemRow());
    prisma.collection.update.mockResolvedValue({});

    const { svc } = makeService(prisma);

    // sans userData → {}
    await svc.create(USER_A, COLL_ID, DTO);
    expect(prisma.item.create.mock.calls[0][0].data.userData).toEqual({});

    // avec userData → passé tel quel
    await svc.create(USER_A, COLL_ID, {
      unifiedData: { title: 'x' },
      userData: { rating: 4, purchasePrice: 12.5 },
    } as CreateItemDto);
    expect(prisma.item.create.mock.calls[1][0].data.userData).toEqual({
      rating: 4,
      purchasePrice: 12.5,
    });
  });

  it('rejette node/volume sur un type plat (400)', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(VINYL_COLL);

    const { svc } = makeService(prisma);
    await expect(
      svc.create(USER_A, COLL_ID, {
        volume: 1,
        unifiedData: { title: 'x' },
      } as CreateItemDto),
    ).rejects.toThrow(/flat collection type/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('mappe P2002 (unique constraint) en ConflictException 409', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(VINYL_COLL);
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
    });
    prisma.item.create.mockRejectedValue(p2002);

    const { svc } = makeService(prisma);
    await expect(svc.create(USER_A, COLL_ID, DTO)).rejects.toThrow(
      ConflictException,
    );
  });

  it('relaie une erreur Prisma non-P2002 sans la masquer', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(VINYL_COLL);
    prisma.item.create.mockRejectedValue(new Error('boom'));

    const { svc } = makeService(prisma);
    await expect(svc.create(USER_A, COLL_ID, DTO)).rejects.toThrow('boom');
  });
});

describe('ItemsService.list', () => {
  it('scope par userId + collectionId et applique le tiebreaker id desc', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(VINYL_COLL);
    prisma.item.findMany.mockResolvedValue([]);

    const { svc } = makeService(prisma);
    await svc.list(USER_A, COLL_ID, { limit: 50 } as never);

    const call = prisma.item.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ collectionId: COLL_ID, userId: USER_A });
    expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(call.take).toBe(51);
  });

  it('rejette ?nodeId sur un type plat (400)', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(VINYL_COLL);

    const { svc } = makeService(prisma);
    await expect(
      svc.list(USER_A, COLL_ID, { limit: 50, nodeId: NODE_ID } as never),
    ).rejects.toThrow(/flat collection type/);
  });

  it('projette en vue légère vinyl', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(VINYL_COLL);
    prisma.item.findMany.mockResolvedValue([
      {
        id: ITEM_ID,
        nodeId: null,
        volume: null,
        unifiedData: { type: 'vinyl', title: 'A', creators: ['x'] },
        userData: { status: 'WISHLIST' },
        node: null,
      },
    ]);

    const { svc } = makeService(prisma);
    const page = await svc.list(USER_A, COLL_ID, { limit: 50 } as never);
    expect(page.data[0]).toEqual({
      id: ITEM_ID,
      type: 'vinyl',
      title: 'A',
      coverUrl: null,
      creators: ['x'],
      genre: [],
      releaseDate: null,
      status: 'WISHLIST',
    });
  });

  it('projette status=OWNED pour un item sans userData.status (avant S1)', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(VINYL_COLL);
    prisma.item.findMany.mockResolvedValue([
      {
        id: ITEM_ID,
        nodeId: null,
        volume: null,
        unifiedData: { type: 'vinyl', title: 'A' },
        userData: {},
        node: null,
      },
    ]);

    const { svc } = makeService(prisma);
    const page = await svc.list(USER_A, COLL_ID, { limit: 50 } as never);
    expect(page.data[0]).toMatchObject({ status: 'OWNED' });
  });

  it('throw NotFound si la collection n’appartient pas au user', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(null);

    const { svc } = makeService(prisma);
    await expect(
      svc.list(USER_B, COLL_ID, { limit: 50 } as never),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ItemsService.findOne', () => {
  it('renvoie l’item curé (sources sans rawData) si scopé sur userId', async () => {
    const prisma = makePrismaMock();
    prisma.item.findFirst.mockResolvedValue(
      itemRow({
        sources: [
          {
            provider: 'isbn',
            externalId: '978',
            rawData: { big: 'payload' },
            fetchedAt: '2026-05-20T00:00:00.000Z',
          },
        ],
      }),
    );

    const { svc } = makeService(prisma);
    const r = await svc.findOne(USER_A, ITEM_ID);
    expect(prisma.item.findFirst).toHaveBeenCalledWith({
      where: { id: ITEM_ID, userId: USER_A },
    });
    expect(r.sources).toEqual([
      {
        provider: 'isbn',
        externalId: '978',
        fetchedAt: '2026-05-20T00:00:00.000Z',
      },
    ]);
    expect(
      (r.sources[0] as unknown as Record<string, unknown>).rawData,
    ).toBeUndefined();
  });

  it('throw NotFound (jamais 403) si l’item appartient à un autre user', async () => {
    const prisma = makePrismaMock();
    prisma.item.findFirst.mockResolvedValue(null);

    const { svc } = makeService(prisma);
    await expect(svc.findOne(USER_B, ITEM_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('ItemsService.update', () => {
  const VINYL_ITEM = {
    ...itemRow({ userData: { rating: 3, purchasePrice: 9 } }),
    collection: { type: { code: 'vinyl' } },
  };

  it('merge userData (PATCH partiel) sur l’existant, sans toucher unifiedData', async () => {
    const prisma = makePrismaMock();
    prisma.item.findFirst.mockResolvedValue(VINYL_ITEM);
    prisma.item.update.mockResolvedValue(itemRow());

    const { svc } = makeService(prisma);
    await svc.update(USER_A, ITEM_ID, {
      userData: { rating: 5, lastPlayedAt: '2026-06-01T10:00:00.000Z' },
    } as never);

    const data = prisma.item.update.mock.calls[0][0].data;
    expect(data.userData).toEqual({
      rating: 5, // écrasé
      purchasePrice: 9, // conservé
      lastPlayedAt: '2026-06-01T10:00:00.000Z', // ajouté
    });
    expect(data.unifiedData).toBeUndefined();
  });

  it('met à jour unifiedData seul sans toucher userData', async () => {
    const prisma = makePrismaMock();
    prisma.item.findFirst.mockResolvedValue(VINYL_ITEM);
    prisma.item.update.mockResolvedValue(itemRow());

    const { svc } = makeService(prisma);
    await svc.update(USER_A, ITEM_ID, {
      unifiedData: { title: 'Nouveau titre' },
    } as never);

    const data = prisma.item.update.mock.calls[0][0].data;
    expect(data.unifiedData).toMatchObject({
      type: 'vinyl',
      title: 'Nouveau titre',
    });
    expect(data.userData).toBeUndefined();
  });

  it('throw NotFound (jamais 403) si l’item appartient à un autre user', async () => {
    const prisma = makePrismaMock();
    prisma.item.findFirst.mockResolvedValue(null);

    const { svc } = makeService(prisma);
    await expect(
      svc.update(USER_B, ITEM_ID, { userData: { rating: 1 } } as never),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ItemsService.remove', () => {
  it('delete + decrement itemCount dans une $transaction (item plat, pas de nœud)', async () => {
    const prisma = makePrismaMock();
    prisma.item.findFirst.mockResolvedValue({
      id: ITEM_ID,
      collectionId: COLL_ID,
      nodeId: null,
    });

    const { svc } = makeService(prisma);
    await svc.remove(USER_A, ITEM_ID);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.item.delete).toHaveBeenCalledWith({ where: { id: ITEM_ID } });
    expect(prisma.collection.update).toHaveBeenCalledWith({
      where: { id: COLL_ID },
      data: { itemCount: { decrement: 1 } },
    });
    expect(prisma.collectionNode.delete).not.toHaveBeenCalled();
  });

  it('purge le nœud devenu vide & non-wishlist (dernier tome)', async () => {
    const prisma = makePrismaMock();
    prisma.item.findFirst.mockResolvedValue({
      id: ITEM_ID,
      collectionId: COLL_ID,
      nodeId: NODE_ID,
    });
    prisma.item.count.mockResolvedValue(0); // plus de tome
    prisma.collectionNode.findUnique.mockResolvedValue({ isWishlist: false });

    const { svc } = makeService(prisma);
    await svc.remove(USER_A, ITEM_ID);

    expect(prisma.collectionNode.delete).toHaveBeenCalledWith({
      where: { id: NODE_ID },
    });
  });

  it('conserve un nœud wishlist même vide', async () => {
    const prisma = makePrismaMock();
    prisma.item.findFirst.mockResolvedValue({
      id: ITEM_ID,
      collectionId: COLL_ID,
      nodeId: NODE_ID,
    });
    prisma.item.count.mockResolvedValue(0);
    prisma.collectionNode.findUnique.mockResolvedValue({ isWishlist: true });

    const { svc } = makeService(prisma);
    await svc.remove(USER_A, ITEM_ID);

    expect(prisma.collectionNode.delete).not.toHaveBeenCalled();
  });

  it('throw NotFound si l’item n’appartient pas au user (pas de delete)', async () => {
    const prisma = makePrismaMock();
    prisma.item.findFirst.mockResolvedValue(null);

    const { svc } = makeService(prisma);
    await expect(svc.remove(USER_B, ITEM_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
