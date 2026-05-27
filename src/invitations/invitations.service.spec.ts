import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HashService } from '../common/crypto/hash.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { InvitationExhaustedException } from './invitation-exhausted.exception';
import { InvitationExpiredException } from './invitation-expired.exception';
import { InvitationsService } from './invitations.service';

const PEPPER = 'pepper-pepper-pepper-pepper-pepper'; // ≥ 32 chars

type PrismaMock = {
  invitation: {
    findUnique: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  invitationRedemption: {
    findUnique: jest.Mock;
    create: jest.Mock;
  };
  premiumGrant: {
    upsert: jest.Mock;
  };
  $transaction: jest.Mock;
};

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    invitation: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn(),
    },
    invitationRedemption: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    premiumGrant: {
      upsert: jest.fn(),
    },
    // Invoque le callback avec le mock lui-même : pas de vraie transaction,
    // mais l'ordre des appels reste observable.
    $transaction: jest.fn((cb) => cb(mock)),
  };
  return mock;
}

function makeService(prisma: PrismaMock): InvitationsService {
  const config = {
    get: jest.fn((key: string) =>
      key === 'INVITE_CODE_PEPPER' ? PEPPER : undefined,
    ),
  } as unknown as ConfigService;
  const svc = new InvitationsService(
    prisma as unknown as PrismaService,
    config,
    new HashService(),
  );
  svc.onModuleInit();
  return svc;
}

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const CODE = 'rawcodeABC123';

// HMAC(PEPPER, CODE) — pré-calculé pour ne pas dépendre du re-hash dans les tests.
function expectedHash(code: string): string {
  return new HashService().hmacSha256Hex(PEPPER, code);
}

describe('InvitationsService.redeem', () => {
  it('throw NotFound si le code est introuvable', async () => {
    const prisma = makePrismaMock();
    prisma.invitation.findUnique.mockResolvedValue(null);

    await expect(makeService(prisma).redeem(CODE, USER)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.invitationRedemption.create).not.toHaveBeenCalled();
    expect(prisma.premiumGrant.upsert).not.toHaveBeenCalled();
  });

  it('throw InvitationExpired (410) si expiresAt < now', async () => {
    const prisma = makePrismaMock();
    prisma.invitation.findUnique.mockResolvedValue({
      codeHash: expectedHash(CODE),
      expiresAt: BigInt(Date.now() - 1000),
      maxUses: 1,
      usedCount: 0,
      grantsPremium: false,
      reason: 'comp',
    });

    await expect(makeService(prisma).redeem(CODE, USER)).rejects.toThrow(
      InvitationExpiredException,
    );
    expect(prisma.invitationRedemption.create).not.toHaveBeenCalled();
  });

  it('retourne {alreadyRedeemed:true} quand le user a déjà claim (idempotence)', async () => {
    const prisma = makePrismaMock();
    prisma.invitation.findUnique.mockResolvedValue({
      codeHash: expectedHash(CODE),
      expiresAt: null,
      maxUses: 5,
      usedCount: 3,
      grantsPremium: true,
      reason: 'beta_tester',
    });
    prisma.invitationRedemption.findUnique.mockResolvedValue({
      invitationCodeHash: expectedHash(CODE),
      userId: USER,
    });

    const res = await makeService(prisma).redeem(CODE, USER);

    expect(res).toEqual({
      alreadyRedeemed: true,
      premiumGranted: true,
      reason: 'beta_tester',
    });
    expect(prisma.invitation.updateMany).not.toHaveBeenCalled();
    expect(prisma.invitationRedemption.create).not.toHaveBeenCalled();
    expect(prisma.premiumGrant.upsert).not.toHaveBeenCalled();
  });

  it('throw InvitationExhausted (409) en steady-state usedCount >= maxUses', async () => {
    const prisma = makePrismaMock();
    prisma.invitation.findUnique.mockResolvedValue({
      codeHash: expectedHash(CODE),
      expiresAt: null,
      maxUses: 5,
      usedCount: 5,
      grantsPremium: false,
      reason: 'comp',
    });

    await expect(makeService(prisma).redeem(CODE, USER)).rejects.toThrow(
      InvitationExhaustedException,
    );
    expect(prisma.invitation.updateMany).not.toHaveBeenCalled();
  });

  it('throw InvitationExhausted (409) sur la race (updateMany.count === 0)', async () => {
    const prisma = makePrismaMock();
    prisma.invitation.findUnique.mockResolvedValue({
      codeHash: expectedHash(CODE),
      expiresAt: null,
      maxUses: 5,
      usedCount: 4,
      grantsPremium: false,
      reason: 'comp',
    });
    prisma.invitation.updateMany.mockResolvedValue({ count: 0 });

    await expect(makeService(prisma).redeem(CODE, USER)).rejects.toThrow(
      InvitationExhaustedException,
    );
    expect(prisma.invitationRedemption.create).not.toHaveBeenCalled();
  });

  it('grants premium via upsert {update: {}} (ne dégrade JAMAIS un grant existant)', async () => {
    const prisma = makePrismaMock();
    const premiumExpiresAt = BigInt(Date.now() + 86_400_000);
    prisma.invitation.findUnique.mockResolvedValue({
      codeHash: expectedHash(CODE),
      expiresAt: null,
      maxUses: 1,
      usedCount: 0,
      grantsPremium: true,
      premiumExpiresAt,
      reason: 'comp',
      createdBy: 'ops',
    });

    await makeService(prisma).redeem(CODE, USER);

    expect(prisma.premiumGrant.upsert).toHaveBeenCalledTimes(1);
    const args = prisma.premiumGrant.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ userId: USER });
    expect(args.update).toEqual({}); // CRITIQUE — un grant existant ne doit pas être touché.
    expect(args.create.userId).toBe(USER);
    expect(args.create.expiresAt).toBe(premiumExpiresAt);
    expect(args.create.grantedBy).toBe('ops');
  });

  it('ne touche pas premiumGrant quand grantsPremium=false', async () => {
    const prisma = makePrismaMock();
    prisma.invitation.findUnique.mockResolvedValue({
      codeHash: expectedHash(CODE),
      expiresAt: null,
      maxUses: 1,
      usedCount: 0,
      grantsPremium: false,
      reason: 'beta_tester',
    });

    const res = await makeService(prisma).redeem(CODE, USER);

    expect(res.premiumGranted).toBe(false);
    expect(prisma.premiumGrant.upsert).not.toHaveBeenCalled();
    expect(prisma.invitationRedemption.create).toHaveBeenCalledTimes(1);
  });

  it('exécute toute la séquence dans $transaction (jamais hors-tx)', async () => {
    const prisma = makePrismaMock();
    prisma.invitation.findUnique.mockResolvedValue({
      codeHash: expectedHash(CODE),
      expiresAt: null,
      maxUses: 1,
      usedCount: 0,
      grantsPremium: true,
      premiumExpiresAt: null,
      reason: 'comp',
    });

    await makeService(prisma).redeem(CODE, USER);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('InvitationsService.create', () => {
  it('génère un code 24 chars base64url (~144 bits) et stocke le hash, pas le code clair', async () => {
    const prisma = makePrismaMock();
    prisma.invitation.create.mockResolvedValue({});

    const { code, codeHash } = await makeService(prisma).create({
      reason: 'comp',
      maxUses: 1,
    } as CreateInvitationDto);

    expect(code).toHaveLength(24);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(codeHash).toBe(expectedHash(code));
    expect(codeHash).toHaveLength(64); // hex sha256

    const call = prisma.invitation.create.mock.calls[0][0];
    expect(call.data.codeHash).toBe(codeHash);
    expect(call.data).not.toHaveProperty('code'); // jamais en clair en base
  });

  it('chaque appel produit un code différent (entropie)', async () => {
    const prisma = makePrismaMock();
    prisma.invitation.create.mockResolvedValue({});

    const svc = makeService(prisma);
    const a = await svc.create({ reason: 'comp' } as CreateInvitationDto);
    const b = await svc.create({ reason: 'comp' } as CreateInvitationDto);

    expect(a.code).not.toBe(b.code);
    expect(a.codeHash).not.toBe(b.codeHash);
  });

  it('passe maxUses/grantsPremium/expiresAt à Prisma quand fournis', async () => {
    const prisma = makePrismaMock();
    prisma.invitation.create.mockResolvedValue({});

    const expiresAt = Date.now() + 86_400_000;
    await makeService(prisma).create({
      reason: 'beta_tester',
      grantsPremium: true,
      maxUses: 50,
      expiresAt,
    } as CreateInvitationDto);

    const call = prisma.invitation.create.mock.calls[0][0];
    expect(call.data.maxUses).toBe(50);
    expect(call.data.grantsPremium).toBe(true);
    expect(call.data.expiresAt).toBe(BigInt(expiresAt));
  });

  it('maxUses défaut à 1 si non fourni', async () => {
    const prisma = makePrismaMock();
    prisma.invitation.create.mockResolvedValue({});

    await makeService(prisma).create({
      reason: 'comp',
    } as CreateInvitationDto);

    const call = prisma.invitation.create.mock.calls[0][0];
    expect(call.data.maxUses).toBe(1);
  });
});

describe('InvitationsService.onModuleInit', () => {
  it('throw si INVITE_CODE_PEPPER absent', () => {
    const prisma = makePrismaMock();
    const config = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    const svc = new InvitationsService(
      prisma as unknown as PrismaService,
      config,
      new HashService(),
    );
    expect(() => svc.onModuleInit()).toThrow(/INVITE_CODE_PEPPER/);
  });

  it('throw si INVITE_CODE_PEPPER < 32 chars', () => {
    const prisma = makePrismaMock();
    const config = {
      get: jest.fn(() => 'too-short'),
    } as unknown as ConfigService;
    const svc = new InvitationsService(
      prisma as unknown as PrismaService,
      config,
      new HashService(),
    );
    expect(() => svc.onModuleInit()).toThrow(/INVITE_CODE_PEPPER/);
  });
});
