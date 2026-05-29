import { BadRequestException, NotFoundException } from '@nestjs/common';
import { QuotaService } from '../common/quota/quota.service';
import { PrismaService } from '../prisma/prisma.service';
import { CollectionsService } from './collections.service';

type PrismaMock = {
  collectionType: { findUnique: jest.Mock };
  collection: {
    create: jest.Mock;
    findMany: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
};

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    collectionType: { findUnique: jest.fn() },
    collection: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    // Invoque le callback avec le mock lui-même : tx === prisma dans les tests.
    $transaction: jest.fn((cb) => cb(mock)),
    $queryRaw: jest.fn(),
  };
  return mock;
}

function makeService(prisma: PrismaMock): CollectionsService {
  const quota = {
    assertCanCreateCollection: jest.fn().mockResolvedValue(undefined),
    assertCanCreateItem: jest.fn().mockResolvedValue(undefined),
    getQuotaSummary: jest.fn(),
  } as unknown as QuotaService;
  return new CollectionsService(prisma as unknown as PrismaService, quota);
}

const USER_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const COLL_ID = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const TYPE_ID = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';

describe('CollectionsService.create', () => {
  it('résout typeCode → typeId, crée et renvoie type (pas typeId)', async () => {
    const prisma = makePrismaMock();
    prisma.collectionType.findUnique.mockResolvedValue({ id: TYPE_ID });
    prisma.collection.create.mockResolvedValue({
      id: COLL_ID,
      userId: USER_A,
      type: { code: 'vinyl' },
    });

    const svc = makeService(prisma);
    const result = await svc.create(USER_A, {
      typeCode: 'vinyl',
      name: 'Ma collection',
      description: 'desc',
    });

    expect(prisma.collectionType.findUnique).toHaveBeenCalledWith({
      where: { code: 'vinyl' },
      select: { id: true },
    });
    expect(prisma.collection.create).toHaveBeenCalledWith({
      data: {
        userId: USER_A,
        typeId: TYPE_ID,
        name: 'Ma collection',
        description: 'desc',
      },
      include: { type: { select: { code: true } } },
    });
    expect(result).toMatchObject({ id: COLL_ID, type: 'vinyl' });
    expect(result).not.toHaveProperty('typeId');
  });

  it('throw BadRequest si typeCode inconnu', async () => {
    const prisma = makePrismaMock();
    prisma.collectionType.findUnique.mockResolvedValue(null);

    const svc = makeService(prisma);
    await expect(
      svc.create(USER_A, { typeCode: 'inexistant', name: 'x' }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.collection.create).not.toHaveBeenCalled();
  });
});

describe('CollectionsService.findOne', () => {
  it('renvoie la collection (type, pas typeId) si le user en est propriétaire', async () => {
    const prisma = makePrismaMock();
    const row = {
      id: COLL_ID,
      userId: USER_A,
      name: 'Ma collection',
      description: null,
      itemCount: 0,
      createdAt: new Date('2026-05-20T00:00:00.000Z'),
      updatedAt: new Date('2026-05-20T00:00:00.000Z'),
      type: { code: 'vinyl' },
    };
    prisma.collection.findFirst.mockResolvedValue(row);

    const result = await makeService(prisma).findOne(USER_A, COLL_ID);

    expect(prisma.collection.findFirst).toHaveBeenCalledWith({
      where: { id: COLL_ID, userId: USER_A },
      include: { type: { select: { code: true } } },
    });
    expect(result).toEqual({
      id: COLL_ID,
      userId: USER_A,
      name: 'Ma collection',
      description: null,
      itemCount: 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      type: 'vinyl',
    });
  });

  it('throw NotFound (jamais 403) si la collection appartient à un autre user', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(null); // findFirst scope sur userId

    await expect(makeService(prisma).findOne(USER_B, COLL_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('CollectionsService.list', () => {
  it('applique le filtre type[in] sur la relation', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findMany.mockResolvedValue([]);

    await makeService(prisma).list(USER_A, {
      limit: 50,
      type: { in: ['vinyl', 'manga'] },
    } as never);

    const call = prisma.collection.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      userId: USER_A,
      type: { code: { in: ['vinyl', 'manga'] } },
    });
    expect(call.take).toBe(51); // limit + 1
    expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('items[in] : contraint findMany sur l’union des collectionId matchants', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ collectionId: 'c1' }])
      .mockResolvedValueOnce([{ collectionId: 'c2' }]);
    prisma.collection.findMany.mockResolvedValue([]);

    await makeService(prisma).list(USER_A, {
      limit: 50,
      items: { in: ['holow', 'naruto'] },
    } as never);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2); // un appel SQL par terme
    const call = prisma.collection.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: USER_A, id: { in: ['c1', 'c2'] } });
  });

  it('items[all] : contraint findMany sur l’intersection des collectionId par terme', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ collectionId: 'c1' }, { collectionId: 'c2' }])
      .mockResolvedValueOnce([{ collectionId: 'c2' }, { collectionId: 'c3' }]);
    prisma.collection.findMany.mockResolvedValue([]);

    await makeService(prisma).list(USER_A, {
      limit: 50,
      items: { all: ['holow', 'naruto'] },
    } as never);

    const call = prisma.collection.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: USER_A, id: { in: ['c2'] } });
  });

  it('items[in] sans match : page vide, sans requête findMany', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw.mockResolvedValue([]);

    const page = await makeService(prisma).list(USER_A, {
      limit: 50,
      items: { in: ['inexistant'] },
    } as never);

    expect(page.data).toEqual([]);
    expect(page.meta.pagination.nextCursor).toBeNull();
    expect(prisma.collection.findMany).not.toHaveBeenCalled();
  });

  it('renvoie nextCursor=null sur une page partielle', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findMany.mockResolvedValue([
      { id: 'r1', type: { code: 'vinyl' } },
      { id: 'r2', type: { code: 'manga' } },
    ]);

    const page = await makeService(prisma).list(USER_A, {
      limit: 50,
    } as never);

    expect(page.data).toHaveLength(2);
    expect(page.data[0]).toMatchObject({ id: 'r1', type: 'vinyl' });
    expect(page.meta.pagination.nextCursor).toBeNull();
  });

  it('utilise skip+cursor quand un curseur est fourni', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findMany.mockResolvedValue([]);

    await makeService(prisma).list(USER_A, {
      limit: 25,
      cursor: COLL_ID,
    } as never);

    const call = prisma.collection.findMany.mock.calls[0][0];
    expect(call.skip).toBe(1);
    expect(call.cursor).toEqual({ id: COLL_ID });
  });
});

describe('CollectionsService.update', () => {
  it('vérifie l’appartenance puis update', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue({ id: COLL_ID });
    prisma.collection.update.mockResolvedValue({
      id: COLL_ID,
      name: 'new',
      type: { code: 'vinyl' },
    });

    const result = await makeService(prisma).update(USER_A, COLL_ID, {
      name: 'new',
    });

    expect(prisma.collection.findFirst).toHaveBeenCalledWith({
      where: { id: COLL_ID, userId: USER_A },
      select: { id: true },
    });
    expect(prisma.collection.update).toHaveBeenCalledWith({
      where: { id: COLL_ID },
      data: { name: 'new' },
      include: { type: { select: { code: true } } },
    });
    expect(result).toMatchObject({ type: 'vinyl' });
  });

  it('throw NotFound si la collection n’appartient pas au user (pas d’update)', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(null);

    await expect(
      makeService(prisma).update(USER_B, COLL_ID, { name: 'pwn' }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.collection.update).not.toHaveBeenCalled();
  });
});

describe('CollectionsService.remove', () => {
  it('vérifie l’appartenance puis delete', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue({ id: COLL_ID });
    prisma.collection.delete.mockResolvedValue({ id: COLL_ID });

    await makeService(prisma).remove(USER_A, COLL_ID);

    expect(prisma.collection.delete).toHaveBeenCalledWith({
      where: { id: COLL_ID },
    });
  });

  it('throw NotFound si pas propriétaire (pas de delete)', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(null);

    await expect(makeService(prisma).remove(USER_B, COLL_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.collection.delete).not.toHaveBeenCalled();
  });
});
