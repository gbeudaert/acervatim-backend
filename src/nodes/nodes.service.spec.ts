import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { LimitsService } from '../common/limits/limits.service';
import { SourceSnapshotService } from '../common/sources/source-snapshot.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShareFilterService } from '../sharing/share-filter.service';
import { CreateNodeDto } from './dto/create-node.dto';
import { NodesService } from './nodes.service';

type PrismaMock = {
  collection: { findFirst: jest.Mock };
  collectionNode: { create: jest.Mock; findFirst: jest.Mock };
  item: { count: jest.Mock };
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
};

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    collection: { findFirst: jest.fn() },
    collectionNode: { create: jest.fn(), findFirst: jest.fn() },
    item: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn((arg) =>
      typeof arg === 'function' ? arg(mock) : Promise.resolve(arg),
    ),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  return mock;
}

function makeLimits(): LimitsService {
  return {
    assertCanCreateNode: jest.fn().mockResolvedValue(undefined),
  } as unknown as LimitsService;
}

function makeSnapshots(rawData: unknown = null): SourceSnapshotService {
  return {
    hasAdapter: jest.fn().mockReturnValue(rawData !== null),
    snapshot: jest.fn((ref: { provider: string; externalId: string }) =>
      Promise.resolve({
        provider: ref.provider,
        externalId: ref.externalId,
        rawData,
        fetchedAt: rawData === null ? null : '2026-08-23T00:00:00.000Z',
      }),
    ),
  } as unknown as SourceSnapshotService;
}

function makeService(
  prisma: PrismaMock,
  snapshots: SourceSnapshotService = makeSnapshots(),
  limits: LimitsService = makeLimits(),
): { svc: NodesService; limits: LimitsService } {
  const shareFilter = {
    nodeWhere: jest.fn().mockResolvedValue(null),
    countItemsByNode: jest.fn().mockResolvedValue({}),
  } as unknown as ShareFilterService;
  const svc = new NodesService(
    prisma as unknown as PrismaService,
    limits,
    snapshots,
    shareFilter,
  );
  return { svc, limits };
}

const USER_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const COLL_ID = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const NODE_ID = 'ffffffff-ffff-4fff-ffff-ffffffffffff';

const MANGA_COLL = { id: COLL_ID, type: { code: 'manga' } };

// Serie telle que l'app la pousse : titre + champs cures, aucune reference provider.
const MANUAL: CreateNodeDto = {
  level: 'serie',
  unifiedData: {
    title: 'Vinland Saga',
    author: 'Makoto Yukimura',
    status: 'ongoing',
    totalCount: 27,
  },
} as CreateNodeDto;

function nodeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: NODE_ID,
    collectionId: COLL_ID,
    userId: USER_A,
    level: 'serie',
    unifiedData: {},
    sources: [],
    userData: {},
    isWishlist: false,
    createdAt: new Date('2026-08-23T00:00:00Z'),
    updatedAt: new Date('2026-08-23T00:00:00Z'),
    ...overrides,
  };
}

describe('NodesService.create - serie sans provider', () => {
  it('cree une serie a partir du seul unifiedData (saisie manuelle)', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(MANGA_COLL);
    prisma.collectionNode.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(nodeRow(data)),
    );
    const { svc, limits } = makeService(prisma);

    const res = await svc.create(USER_A, COLL_ID, MANUAL);

    expect(res).toMatchObject({
      level: 'serie',
      title: 'Vinland Saga',
      author: 'Makoto Yukimura',
      status: 'ongoing',
      totalCount: 27,
      ownedCount: 0,
      sources: [],
    });
    // Aucune source : ni appel reseau, ni dedup a faire. Le plafond technique reste verifie.
    expect(limits.assertCanCreateNode).toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('accepte une source sans adapter quand le unifiedData decrit la serie', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(MANGA_COLL);
    prisma.collectionNode.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(nodeRow(data)),
    );
    const { svc } = makeService(prisma, makeSnapshots(null));

    const res = await svc.create(USER_A, COLL_ID, {
      ...MANUAL,
      source: { provider: 'mangadex', externalId: 'abc' },
    } as CreateNodeDto);

    expect(res.title).toBe('Vinland Saga');
    expect(res.sources).toEqual([
      { provider: 'mangadex', externalId: 'abc', fetchedAt: null },
    ]);
  });

  it('refuse une source sans adapter ni unifiedData (rien ne decrit le noeud)', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(MANGA_COLL);
    const { svc } = makeService(prisma, makeSnapshots(null));

    await expect(
      svc.create(USER_A, COLL_ID, {
        level: 'serie',
        source: { provider: 'mangadex', externalId: 'abc' },
      } as CreateNodeDto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.collectionNode.create).not.toHaveBeenCalled();
  });

  it('unifiedData invalide : 400 de validation, pas une 500', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(MANGA_COLL);
    const { svc } = makeService(prisma);

    await expect(
      svc.create(USER_A, COLL_ID, {
        level: 'serie',
        unifiedData: { title: '' }, // min(1)
      } as CreateNodeDto),
    ).rejects.toBeInstanceOf(ZodValidationException);
  });

  it('le unifiedData du client l emporte sur le snapshot provider', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(MANGA_COLL);
    prisma.collectionNode.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(nodeRow(data)),
    );
    const snapshots = makeSnapshots({
      source: 'mal',
      sourceId: '9',
      mediaType: 'manga',
      title: 'Titre MAL',
      creators: ['MAL'],
      description: null,
      coverUrl: null,
      metadata: { status: 'finished', num_volumes: 1 },
    });
    const { svc } = makeService(prisma, snapshots);

    const res = await svc.create(USER_A, COLL_ID, {
      ...MANUAL,
      source: { provider: 'mal', externalId: '9' },
    } as CreateNodeDto);

    expect(res.title).toBe('Vinland Saga');
  });

  it('dedup par source inchangee : un noeud deja rattache est renvoye tel quel', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(MANGA_COLL);
    prisma.$queryRaw.mockResolvedValue([{ id: NODE_ID }]);
    prisma.collectionNode.findFirst.mockResolvedValue(
      nodeRow({ unifiedData: { title: 'Deja la' } }),
    );
    const { svc } = makeService(prisma);

    const res = await svc.create(USER_A, COLL_ID, {
      level: 'serie',
      source: { provider: 'mal', externalId: '9' },
    } as CreateNodeDto);

    expect(res.id).toBe(NODE_ID);
    expect(prisma.collectionNode.create).not.toHaveBeenCalled();
  });

  it('niveau inconnu pour ce type : 400', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(MANGA_COLL);
    const { svc } = makeService(prisma);

    await expect(
      svc.create(USER_A, COLL_ID, {
        ...MANUAL,
        level: 'saison',
      } as CreateNodeDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('collection d un autre compte : 404', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(null);
    const { svc } = makeService(prisma);

    await expect(svc.create(USER_A, COLL_ID, MANUAL)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
