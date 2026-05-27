import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { QuotaService } from '../common/quota/quota.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateItemDto } from './dto/create-item.dto';
import { ItemsService } from './items.service';

type PrismaMock = {
  collection: { findFirst: jest.Mock; update: jest.Mock };
  item: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    delete: jest.Mock;
  };
  $transaction: jest.Mock;
};

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    collection: { findFirst: jest.fn(), update: jest.fn() },
    item: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
    },
    // $transaction supporte les 2 formes :
    //  - callback : on l'invoque avec le mock comme tx
    //  - array : on retourne le tableau tel quel (remove() utilise cette forme)
    $transaction: jest.fn((arg) =>
      typeof arg === 'function' ? arg(mock) : Promise.resolve(arg),
    ),
  };
  return mock;
}

function makeQuota(): QuotaService {
  return {
    assertCanCreateCollection: jest.fn(),
    assertCanCreateItem: jest.fn().mockResolvedValue(undefined),
    getQuotaSummary: jest.fn(),
  } as unknown as QuotaService;
}

function makeService(
  prisma: PrismaMock,
  quota: QuotaService = makeQuota(),
): { svc: ItemsService; quota: QuotaService } {
  const svc = new ItemsService(prisma as unknown as PrismaService, quota);
  return { svc, quota };
}

const USER_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const COLL_ID = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const ITEM_ID = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee';

const DTO: CreateItemDto = {
  source: 'discogs',
  sourceId: 'disc-123',
  unifiedData: { title: 'X' },
  rawData: { raw: true },
} as CreateItemDto;

describe('ItemsService.create', () => {
  it('throw NotFound (jamais 403) si la collection appartient à un autre user', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(null); // findFirst scope userId

    const { svc } = makeService(prisma);
    await expect(svc.create(USER_B, COLL_ID, DTO)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.item.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('appelle assertCanCreateItem AVEC le tx (TOCTOU réduit)', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue({ id: COLL_ID });
    prisma.item.create.mockResolvedValue({ id: ITEM_ID });
    prisma.collection.update.mockResolvedValue({});

    const quota = makeQuota();
    const { svc } = makeService(prisma, quota);
    await svc.create(USER_A, COLL_ID, DTO);

    // Le 2ᵉ argument doit être le tx (ici === prisma mock)
    expect(quota.assertCanCreateItem).toHaveBeenCalledWith(USER_A, prisma);
  });

  it('crée l’item ET incrémente itemCount dans la même $transaction', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue({ id: COLL_ID });
    prisma.item.create.mockResolvedValue({ id: ITEM_ID });
    prisma.collection.update.mockResolvedValue({});

    const { svc } = makeService(prisma);
    const item = await svc.create(USER_A, COLL_ID, DTO);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.item.create).toHaveBeenCalledTimes(1);
    expect(prisma.collection.update).toHaveBeenCalledWith({
      where: { id: COLL_ID },
      data: { itemCount: { increment: 1 } },
    });
    expect(item).toEqual({ id: ITEM_ID });
  });

  it('mappe P2002 (unique constraint) en ConflictException 409', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue({ id: COLL_ID });
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
    prisma.collection.findFirst.mockResolvedValue({ id: COLL_ID });
    prisma.item.create.mockRejectedValue(new Error('boom'));

    const { svc } = makeService(prisma);
    await expect(svc.create(USER_A, COLL_ID, DTO)).rejects.toThrow('boom');
  });
});

describe('ItemsService.list', () => {
  it('scope par userId + collectionId et applique le tiebreaker id desc', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue({ id: COLL_ID });
    prisma.item.findMany.mockResolvedValue([]);

    const { svc } = makeService(prisma);
    await svc.list(USER_A, COLL_ID, { limit: 50 } as never);

    const call = prisma.item.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ collectionId: COLL_ID, userId: USER_A });
    expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(call.take).toBe(51);
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
  it('renvoie l’item si scopé sur userId', async () => {
    const prisma = makePrismaMock();
    const row = { id: ITEM_ID, userId: USER_A, collectionId: COLL_ID };
    prisma.item.findFirst.mockResolvedValue(row);

    const { svc } = makeService(prisma);
    const r = await svc.findOne(USER_A, ITEM_ID);
    expect(r).toBe(row);
    expect(prisma.item.findFirst).toHaveBeenCalledWith({
      where: { id: ITEM_ID, userId: USER_A },
    });
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

describe('ItemsService.remove', () => {
  it('delete + decrement itemCount dans une seule $transaction', async () => {
    const prisma = makePrismaMock();
    prisma.item.findFirst.mockResolvedValue({
      id: ITEM_ID,
      userId: USER_A,
      collectionId: COLL_ID,
    });

    const { svc } = makeService(prisma);
    await svc.remove(USER_A, ITEM_ID);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Forme array : Prisma.PrismaPromise[] passé à $transaction
    expect(Array.isArray(prisma.$transaction.mock.calls[0][0])).toBe(true);
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
