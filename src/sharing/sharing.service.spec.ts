import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogService } from '../common/audit/audit-log.service';
import { HashService } from '../common/crypto/hash.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShareCodeInvalidException } from './share-code-invalid.exception';
import { SharingService } from './sharing.service';

const PEPPER = 'share-pepper-share-pepper-share-p'; // >= 32 chars

const OWNER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const MEMBER = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const COLLECTION = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const SHARE = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
const CODE = 'rawShareCode123';

const COLLECTION_ROW = {
  id: COLLECTION,
  name: 'Vinyles',
  itemCount: 12,
  type: { code: 'vinyl' },
};

type PrismaMock = {
  collection: { findFirst: jest.Mock };
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
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  $transaction: jest.Mock;
};

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    collection: { findFirst: jest.fn().mockResolvedValue({ id: COLLECTION }) },
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
  );
  service.onModuleInit();
  return { service, audit };
}

function expectedHash(code: string): string {
  return new HashService().hmacSha256Hex(PEPPER, code);
}

/** Partage nominal : actif, une place libre, jamais expiré. */
function activeShare(overrides: Record<string, unknown> = {}) {
  return {
    id: SHARE,
    collectionId: COLLECTION,
    ownerUserId: OWNER,
    codeHash: expectedHash(CODE),
    scope: 'owned',
    maxUses: 1,
    usedCount: 0,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date(0),
    collection: COLLECTION_ROW,
    ...overrides,
  };
}

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
    );
    expect(() => service.onModuleInit()).toThrow(/SHARE_CODE_PEPPER/);
  });
});

describe('SharingService.create', () => {
  it('stocke le HMAC du code, jamais le code, et ne le rend qu’une fois', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          ...activeShare(),
          ...data,
          id: SHARE,
          usedCount: 0,
          createdAt: new Date(0),
        }),
    );
    const { service, audit } = makeService(prisma);

    const created = await service.create(OWNER, COLLECTION, { scope: 'owned' });

    expect(created.code).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const stored = prisma.collectionShare.create.mock.calls[0][0].data;
    expect(stored.codeHash).toBe(expectedHash(created.code));
    expect(JSON.stringify(stored)).not.toContain(created.code);
    expect(stored.maxUses).toBe(1);
    expect(stored.expiresAt).toBeNull();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'share.create',
        target: SHARE,
        metadata: { scope: 'owned' },
      }),
    );
    // Jamais le code en clair dans l'audit.
    expect(JSON.stringify(audit.record.mock.calls[0][0])).not.toContain(
      created.code,
    );
  });

  it('404 si la collection est celle de quelqu’un d’autre', async () => {
    const prisma = makePrismaMock();
    prisma.collection.findFirst.mockResolvedValue(null);
    const { service } = makeService(prisma);

    await expect(
      service.create(OWNER, COLLECTION, { scope: 'all' }),
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
      collectionId: COLLECTION,
      scope: 'owned',
      alreadyMember: false,
      collection: { id: COLLECTION, name: 'Vinyles', type: 'vinyl' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'share.redeem', target: SHARE }),
    );
  });

  it('est idempotent pour un membre déjà actif : aucune place reconsommée', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findUnique.mockResolvedValue(
      activeShare({ maxUses: 1, usedCount: 1 }),
    );
    prisma.collectionShareMember.findUnique.mockResolvedValue({
      redeemedAt: new Date(2),
      revokedAt: null,
    });
    const { service, audit } = makeService(prisma);

    const res = await service.redeem(CODE, MEMBER);

    expect(res.alreadyMember).toBe(true);
    expect(prisma.collectionShare.updateMany).not.toHaveBeenCalled();
    expect(prisma.collectionShareMember.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
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

describe('SharingService.revoke', () => {
  it('marque le partage ET ses membres, sans rien supprimer', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findFirst.mockResolvedValue({
      id: SHARE,
      scope: 'all',
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
      scope: 'all',
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
      scope: 'wantlist',
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
        metadata: { scope: 'wantlist' },
      }),
    );
  });

  it('404 si le membre n’a jamais rejoint ce partage', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findFirst.mockResolvedValue({
      id: SHARE,
      scope: 'all',
      revokedAt: null,
    });
    prisma.collectionShareMember.findUnique.mockResolvedValue(null);
    const { service } = makeService(prisma);

    await expect(service.revokeMember(OWNER, SHARE, MEMBER)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('SharingService.list', () => {
  it('ne renvoie ni le code ni son hash', async () => {
    const prisma = makePrismaMock();
    prisma.collectionShare.findMany.mockResolvedValue([
      {
        ...activeShare({ expiresAt: BigInt(1_700_000_000_000) }),
        members: [{ memberUserId: MEMBER, redeemedAt: new Date(0) }],
      },
    ]);
    const { service } = makeService(prisma);

    const [view] = await service.list(OWNER, COLLECTION);

    expect(view).not.toHaveProperty('codeHash');
    expect(view).not.toHaveProperty('code');
    // BigInt -> number : sinon la sérialisation JSON de la réponse échoue.
    expect(view.expiresAt).toBe(1_700_000_000_000);
    expect(view.members).toEqual([
      { memberUserId: MEMBER, redeemedAt: new Date(0) },
    ]);
  });

  it('ne liste que les partages non révoqués', async () => {
    const prisma = makePrismaMock();
    const { service } = makeService(prisma);

    await service.list(OWNER, COLLECTION);

    expect(prisma.collectionShare.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { collectionId: COLLECTION, revokedAt: null },
      }),
    );
  });
});

describe('SharingService.listReceived', () => {
  it('exclut les adhésions révoquées et les partages révoqués, pas les codes expirés', async () => {
    const prisma = makePrismaMock();
    const { service } = makeService(prisma);

    await service.listReceived(MEMBER);

    expect(prisma.collectionShareMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberUserId: MEMBER,
          revokedAt: null,
          share: { revokedAt: null },
        },
      }),
    );
  });
});
