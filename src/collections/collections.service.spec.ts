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
};

function makePrismaMock(): PrismaMock {
  return {
    collectionType: { findUnique: jest.fn() },
    collection: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
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
  it('résout typeCode → typeId et crée', async () => {
    const prisma = makePrismaMock();
    prisma.collectionType.findUnique.mockResolvedValue({ id: TYPE_ID });
    prisma.collection.create.mockResolvedValue({ id: COLL_ID, userId: USER_A });

    const svc = makeService(prisma);
    await svc.create(USER_A, {
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
    });
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
  it('renvoie la collection si le user en est propriétaire', async () => {
    const prisma = makePrismaMock();
    const row = { id: COLL_ID, userId: USER_A };
    prisma.collection.findFirst.mockResolvedValue(row);

    const result = await makeService(prisma).findOne(USER_A, COLL_ID);

    expect(prisma.collection.findFirst).toHaveBeenCalledWith({
      where: { id: COLL_ID, userId: USER_A },
    });
    expect(result).toBe(row);
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
    expect(call.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('renvoie nextCursor=null sur une page partielle', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);

    const page = await makeService(prisma).list(USER_A, {
      limit: 50,
    } as never);

    expect(page.data).toHaveLength(2);
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
    prisma.collection.update.mockResolvedValue({ id: COLL_ID, name: 'new' });

    await makeService(prisma).update(USER_A, COLL_ID, { name: 'new' });

    expect(prisma.collection.update).toHaveBeenCalledWith({
      where: { id: COLL_ID },
      data: { name: 'new' },
    });
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
