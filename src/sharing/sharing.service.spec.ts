import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogService } from '../common/audit/audit-log.service';
import { HashService } from '../common/crypto/hash.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateShareDto } from './dto/create-share.dto';
import { ShareCodeInvalidException } from './share-code-invalid.exception';
import { ShareFilterService } from './share-filter.service';
import { SharingService } from './sharing.service';

const PEPPER = 'share-pepper-share-pepper-share-p'; // >= 32 chars

const OWNER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const MEMBER = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const COLLECTION = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const COLLECTION_2 = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee';
const SHARE = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
const CODE = 'rawShareCode123';

/** Ce que le membre verra sous les statuts du partage. Distinct d'un total de collection, exprès. */
const VISIBLE_ITEM_COUNT = 7;

function entryRow(collectionId: string, statuses: string[]) {
  return {
    collectionId,
    statuses,
    collection: { name: 'Vinyles', type: { code: 'vinyl' } },
  };
}

type PrismaMock = {
  collection: { count: jest.Mock };
  collectionShare: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  collectionShareMember: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  $transaction: jest.Mock;
};

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    // Par defaut : le requerant possede toutes les collections qu'il demande a partager.
    collection: { count: jest.fn().mockResolvedValue(1) },
    collectionShare: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    collectionShareMember: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ redeemedAt: new Date(0) }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // Couvre les deux formes utilisées par le service : callback (redeem) et tableau (revoke).
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: PrismaMock) => unknown)(mock)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  return mock;
}

// Le compte visible est l'affaire de ShareFilterService : ici il n'est pas l'objet du test.
function makeFilter(): ShareFilterService {
  return {
    countItems: jest.fn().mockResolvedValue(VISIBLE_ITEM_COUNT),
  } as unknown as ShareFilterService;
}

function makeService(prisma: PrismaMock): {
  service: SharingService;
  audit: { record: jest.Mock };
} {
  const config = {
    get: jest.fn((key: string) =>
      key === 'SHARE_CODE_PEPPER' ? PEPPER : undefined,
    ),
  } as unknown as ConfigService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new SharingService(
    prisma as unknown as PrismaService,
    config,
    new HashService(),
    audit as unknown as AuditLogService,
    makeFilter(),
  );
  service.onModuleInit();
  return { service, audit };
}

function expectedHash(code: string): string {
  return new HashService().hmacSha256Hex(PEPPER, code);
}

/** Partage nominal : actif, une place libre, jamais expiré, une collection en « possédés ». */
function activeShare(overrides: Record<string, unknown> = {}) {
  return {
    id: SHARE,
    ownerUserId: OWNER,
    codeHash: expectedHash(CODE),
    label: 'Wantlist manga avec Alice',
    maxUses: 1,
    usedCount: 0,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date(0),
    entries: [entryRow(COLLECTION, ['OWNED'])],
    ...overrides,
  };
}

const dto = (over: Partial<CreateShareDto> = {}): CreateShareDto =>
  ({
    collections: [{ collectionId: COLLECTION, statuses: ['OWNED'] }],
    ...over,
  }) as CreateShareDto;

describe('SharingService.onModuleInit', () => {
  it('refuse de démarrer sans SHARE_CODE_PEPPER', () => {
    const config = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    const service = new SharingService(
      makePrismaMock() as unknown as PrismaService,
      config,
      new HashService(),
      { record: jest.fn() } as unknown as AuditLogService,
      makeFilter(),
    );
    expect(() => service.onModuleInit()).toThrow(/SHARE_CODE_PEPPER/);
  });

  it('refuse un pepper trop court', () => {
    const config = {
      get: jest.fn(() => 'trop-court'),
    } as unknown as ConfigService;
    const service = new SharingService(
      makePrismaMock() as unknown as PrismaService,
      config,
      new HashService(),
      { record: jest.fn() } as unknown as AuditLogService,
      makeFilter(),
    );
    expect(() => service.onModuleInit()).toThrow(/SHARE_CODE_PEPPER/);
  });
});

describe('SharingService.create', () => {
  it('stocke le HMAC du code, jamais le code, et ne le rend qu’une fois', async () => {
    const prisma = makePrismaMock();
    // `data.entries` est une instruction d'ecriture imbriquee ({ create: [...] }) : elle ne doit
    // pas ecraser les entrees relues, que Prisma renvoie a plat.
    prisma.collectionShare.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          ...activeShare(),
          ...data,
          entries: activeShare().entries,
          id: SHARE,
        }),
    );
    const { service, audit } = makeService(prisma);

    const created = await service.create(OWNER, dto());

    expect(created.code).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const stored = prisma.collectionShare.create.mock.calls[0][0].data;
    expect(stored.codeHash).toBe(expectedHash(created.code));
    expect(JSON.stringify(stored)).not.toContain(created.code);
    expect(stored.maxUses).toBe(1);
    expect(stored.expiresAt).toBeNull();
  });

  it('enregistre une entrée par collection, statuts normalisés', async () => {
    const prisma = makePrismaMock();
    prisma.collection.count.mockResolvedValue(2);
    prisma.collectionShare.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          ...activeShare(),
          ...data,
          id: SHARE,
          entries: [
            entryRow(COLLECTION, ['WISHLIST']),
            entryRow(COLLECTION_2, ['OWNED', 'WISHLIST']),
          ],
        }),
    );
    const { service } = makeService(prisma);

    const created = await service.create(
      OWNER,
      dto({
        label: 'Wantlist manga avec Alice',
        collections: [
          { collectionId: COLLECTION, statuses: ['WISHLIST'] },
          // Ordre inverse et doublon : doit ressortir normalisé.
          {
            collectionId: COLLECTION_2,
            statuses: ['WISHLIST', 'OWNED', 'OWNED'],
          },
        ],
      } as Partial<CreateShareDto>),
    );

    const stored = prisma.collectionShare.create.mock.calls[0][0].data;
    expect(stored.entries.create).toEqual([
      { collectionId: COLLECTION, statuses: ['WISHLIST'] },
      { collectionId: COLLECTION_2, statuses: ['OWNED', 'WISHLIST'] },
    ]);
    expect(stored.label).toBe('Wantlist manga avec Alice');
    expect(created.collections).toHaveLength(2);
  });

  // Le libelle nomme souvent quelqu'un : il reste dans sa colonne.
  it('ne met ni le libellé ni les collections dans l’audit', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.create.mockResolvedValue(activeShare());
    const { service, audit } = makeService(prisma);

    await service.create(OWNER, dto({ label: 'Partage avec Alice' }));

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'share.create',
        target: SHARE,
        metadata: { collections: 1 },
      }),
    );
    const recorded = JSON.stringify(audit.record.mock.calls[0][0]);
    expect(recorded).not.toContain('Alice');
    expect(recorded).not.toContain(COLLECTION);
  });

  it('404 si l’une des collections est celle de quelqu’un d’autre', async () => {
    const prisma = makePrismaMock();
    // Deux demandées, une seule possédée.
    prisma.collection.count.mockResolvedValue(1);
    const { service } = makeService(prisma);

    await expect(
      service.create(
        OWNER,
        dto({
          collections: [
            { collectionId: COLLECTION, statuses: ['OWNED'] },
            { collectionId: COLLECTION_2, statuses: ['OWNED'] },
          ],
        } as Partial<CreateShareDto>),
      ),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.collectionShare.create).not.toHaveBeenCalled();
  });
});

describe('SharingService.redeem', () => {
  it('crée le membre et incrémente usedCount sous garde optimiste', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findUnique.mockResolvedValue(activeShare());
    prisma.collectionShareMember.create.mockResolvedValue({
      redeemedAt: new Date(1),
      label: null,
    });
    const { service, audit } = makeService(prisma);

    const res = await service.redeem(CODE, MEMBER);

    expect(prisma.collectionShare.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { codeHash: expectedHash(CODE) } }),
    );
    expect(prisma.collectionShare.updateMany).toHaveBeenCalledWith({
      where: { id: SHARE, usedCount: { lt: 1 } },
      data: { usedCount: { increment: 1 } },
    });
    expect(res).toMatchObject({
      shareId: SHARE,
      alreadyMember: false,
      collections: [
        {
          collectionId: COLLECTION,
          statuses: ['OWNED'],
          // Le compte est celui des statuts exposés, pas le total de la collection.
          itemCount: VISIBLE_ITEM_COUNT,
        },
      ],
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'share.redeem', target: SHARE }),
    );
  });

  // Le libelle du proprietaire nomme peut-etre le membre lui-meme, ou un autre membre du code.
  it('ne transmet jamais le libellé du propriétaire au membre', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findUnique.mockResolvedValue(
      activeShare({ label: 'Wantlist manga avec Alice' }),
    );
    prisma.collectionShareMember.create.mockResolvedValue({
      redeemedAt: new Date(1),
      label: 'Wantlist manga de Bob',
    });
    const { service } = makeService(prisma);

    const res = await service.redeem(CODE, MEMBER, 'Wantlist manga de Bob');

    expect(res.label).toBe('Wantlist manga de Bob');
    expect(JSON.stringify(res)).not.toContain('Alice');
  });

  it('est idempotent pour un membre déjà actif : aucune place reconsommée', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findUnique.mockResolvedValue(
      activeShare({ maxUses: 1, usedCount: 1 }),
    );
    prisma.collectionShareMember.findUnique.mockResolvedValue({
      redeemedAt: new Date(2),
      revokedAt: null,
      label: 'deja nomme',
    });
    const { service, audit } = makeService(prisma);

    const res = await service.redeem(CODE, MEMBER);

    expect(res.alreadyMember).toBe(true);
    expect(res.label).toBe('deja nomme');
    expect(prisma.collectionShare.updateMany).not.toHaveBeenCalled();
    expect(prisma.collectionShareMember.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('applique tout de même un libellé fourni par un membre déjà actif', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findUnique.mockResolvedValue(activeShare());
    prisma.collectionShareMember.findUnique.mockResolvedValue({
      redeemedAt: new Date(2),
      revokedAt: null,
      label: null,
    });
    const { service } = makeService(prisma);

    const res = await service.redeem(CODE, MEMBER, 'renomme');

    expect(res.label).toBe('renomme');
    expect(prisma.collectionShareMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { label: 'renomme' } }),
    );
  });

  it.each([
    ['code inconnu', null],
    ['partage révoqué', activeShare({ revokedAt: new Date() })],
    ['code expiré', activeShare({ expiresAt: BigInt(Date.now() - 1000) })],
    ['places épuisées', activeShare({ maxUses: 2, usedCount: 2 })],
  ])(
    'refuse sans oracle (%s) : même exception, aucun membre créé',
    async (_label, share) => {
      const prisma = makePrismaMock();
      prisma.collectionShare.findUnique.mockResolvedValue(share);
      const { service } = makeService(prisma);

      await expect(service.redeem(CODE, MEMBER)).rejects.toThrow(
        ShareCodeInvalidException,
      );
      expect(prisma.collectionShareMember.create).not.toHaveBeenCalled();
    },
  );

  it('refuse un membre déjà éjecté, même si le partage vit encore', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findUnique.mockResolvedValue(
      activeShare({ maxUses: 5, usedCount: 1 }),
    );
    prisma.collectionShareMember.findUnique.mockResolvedValue({
      redeemedAt: new Date(2),
      revokedAt: new Date(3),
    });
    const { service } = makeService(prisma);

    await expect(service.redeem(CODE, MEMBER)).rejects.toThrow(
      ShareCodeInvalidException,
    );
    expect(prisma.collectionShareMember.create).not.toHaveBeenCalled();
  });

  it('refuse au propriétaire de rejoindre son propre partage (400 explicite)', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findUnique.mockResolvedValue(activeShare());
    const { service } = makeService(prisma);

    await expect(service.redeem(CODE, OWNER)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuse si la garde optimiste perd la course sur la dernière place', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findUnique.mockResolvedValue(activeShare());
    prisma.collectionShare.updateMany.mockResolvedValue({ count: 0 });
    const { service } = makeService(prisma);

    await expect(service.redeem(CODE, MEMBER)).rejects.toThrow(
      ShareCodeInvalidException,
    );
    expect(prisma.collectionShareMember.create).not.toHaveBeenCalled();
  });
});

describe('SharingService.updateLabel', () => {
  it('renomme un partage émis, sans toucher à ce qu’il expose', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findFirst.mockResolvedValue({
      id: SHARE,
      revokedAt: null,
    });
    prisma.collectionShare.update.mockResolvedValue({
      ...activeShare({ label: 'Nouveau nom' }),
      members: [],
    });
    const { service } = makeService(prisma);

    const res = await service.updateLabel(OWNER, SHARE, 'Nouveau nom');

    expect(prisma.collectionShare.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SHARE },
        data: { label: 'Nouveau nom' },
      }),
    );
    expect(res.label).toBe('Nouveau nom');
    expect(res.collections).toEqual([
      {
        collectionId: COLLECTION,
        name: 'Vinyles',
        type: 'vinyl',
        statuses: ['OWNED'],
      },
    ]);
  });

  it('404 sur le partage d’un autre propriétaire', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findFirst.mockResolvedValue(null);
    const { service } = makeService(prisma);

    await expect(service.updateLabel(MEMBER, SHARE, 'x')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.collectionShare.update).not.toHaveBeenCalled();
  });
});

describe('SharingService.updateMembershipLabel', () => {
  it('renomme côté membre une adhésion vivante', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShareMember.findFirst.mockResolvedValue({
      shareId: SHARE,
    });
    prisma.collectionShareMember.update.mockResolvedValue({
      shareId: SHARE,
      label: 'Full collection de Charlie',
      redeemedAt: new Date(4),
      share: activeShare(),
    });
    const { service } = makeService(prisma);

    const res = await service.updateMembershipLabel(
      MEMBER,
      SHARE,
      'Full collection de Charlie',
    );

    expect(res.label).toBe('Full collection de Charlie');
    expect(res.collections[0].itemCount).toBe(VISIBLE_ITEM_COUNT);
  });

  it('404 si l’adhésion n’existe pas ou a été révoquée', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShareMember.findFirst.mockResolvedValue(null);
    const { service } = makeService(prisma);

    await expect(
      service.updateMembershipLabel(MEMBER, SHARE, 'x'),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.collectionShareMember.update).not.toHaveBeenCalled();
  });
});

describe('SharingService.revoke', () => {
  it('marque le partage ET ses membres, sans rien supprimer', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findFirst.mockResolvedValue({
      id: SHARE,
      revokedAt: null,
    });
    const { service, audit } = makeService(prisma);

    await service.revoke(OWNER, SHARE);

    expect(prisma.collectionShare.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SHARE } }),
    );
    expect(prisma.collectionShareMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shareId: SHARE, revokedAt: null } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'share.revoke', target: SHARE }),
    );
  });

  it('est idempotent sur un partage déjà révoqué', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findFirst.mockResolvedValue({
      id: SHARE,
      revokedAt: new Date(),
    });
    const { service, audit } = makeService(prisma);

    await service.revoke(OWNER, SHARE);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('404 sur le partage d’un autre propriétaire', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findFirst.mockResolvedValue(null);
    const { service } = makeService(prisma);

    await expect(service.revoke(MEMBER, SHARE)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('SharingService.revokeMember', () => {
  it('éjecte un membre sans toucher au partage', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findFirst.mockResolvedValue({
      id: SHARE,
      revokedAt: null,
    });
    prisma.collectionShareMember.findUnique.mockResolvedValue({
      revokedAt: null,
    });
    const { service, audit } = makeService(prisma);

    await service.revokeMember(OWNER, SHARE, MEMBER);

    expect(prisma.collectionShareMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          shareId_memberUserId: { shareId: SHARE, memberUserId: MEMBER },
        },
      }),
    );
    expect(prisma.collectionShare.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'share.member.revoke',
        target: SHARE,
      }),
    );
  });

  it('404 si le membre n’a jamais rejoint ce partage', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findFirst.mockResolvedValue({
      id: SHARE,
      revokedAt: null,
    });
    prisma.collectionShareMember.findUnique.mockResolvedValue(null);
    const { service } = makeService(prisma);

    await expect(service.revokeMember(OWNER, SHARE, MEMBER)).rejects.toThrow(
      NotFoundException,
    );
  });
});
