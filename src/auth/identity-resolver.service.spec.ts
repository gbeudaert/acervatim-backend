import { ConfigService } from '@nestjs/config';
import { HashService } from '../common/crypto/hash.service';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityResolverService } from './identity-resolver.service';

const PEPPER = 'pepper-pepper-pepper-pepper-pepper'; // ≥ 32 chars

type PrismaMock = {
  user: { findUnique: jest.Mock; create: jest.Mock };
};

function makePrismaMock(): PrismaMock {
  return {
    user: { findUnique: jest.fn(), create: jest.fn() },
  };
}

function makeServiceWithPepper(
  prisma: PrismaMock,
  pepper: string | undefined,
): IdentityResolverService {
  const config = {
    get: jest.fn((k: string) => (k === 'SUB_HASH_PEPPER' ? pepper : undefined)),
  } as unknown as ConfigService;
  const svc = new IdentityResolverService(
    prisma as unknown as PrismaService,
    config,
    new HashService(),
  );
  svc.onModuleInit();
  return svc;
}

function makeService(prisma: PrismaMock): IdentityResolverService {
  return makeServiceWithPepper(prisma, PEPPER);
}

const SUBJECT = 'google-sub-1234567890';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

function expectedHash(subject: string): string {
  return new HashService().hmacSha256Hex(PEPPER, `google:${subject}`);
}

describe('IdentityResolverService.resolveOrCreate', () => {
  it('hash inclut le préfixe provider — pas le subject brut', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID });

    await makeService(prisma).resolveOrCreate('google', SUBJECT);

    const call = prisma.user.findUnique.mock.calls[0][0];
    expect(call.where.googleSubHash).toBe(expectedHash(SUBJECT));
    // Sanity : un hash sans préfixe serait différent
    const naive = new HashService().hmacSha256Hex(PEPPER, SUBJECT);
    expect(call.where.googleSubHash).not.toBe(naive);
  });

  it('retourne {userId, isNew:false} quand le user existe (pas de create)', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID });

    const res = await makeService(prisma).resolveOrCreate('google', SUBJECT);

    expect(res).toEqual({ userId: USER_ID, isNew: false });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('crée un user avec le hash quand inexistant (isNew:true)', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: USER_ID });

    const res = await makeService(prisma).resolveOrCreate('google', SUBJECT);

    expect(res).toEqual({ userId: USER_ID, isNew: true });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { googleSubHash: expectedHash(SUBJECT) },
      select: { id: true },
    });
  });

  it('idempotent : 2 appels avec le même subject hashent pareil', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID });

    const svc = makeService(prisma);
    await svc.resolveOrCreate('google', SUBJECT);
    await svc.resolveOrCreate('google', SUBJECT);

    const h1 = prisma.user.findUnique.mock.calls[0][0].where.googleSubHash;
    const h2 = prisma.user.findUnique.mock.calls[1][0].where.googleSubHash;
    expect(h1).toBe(h2);
  });

  it('throw pour un provider non câblé', async () => {
    const prisma = makePrismaMock();
    const svc = makeService(prisma);

    await expect(svc.resolveOrCreate('apple', SUBJECT)).rejects.toThrow(
      /not yet wired/,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('IdentityResolverService.onModuleInit', () => {
  it('throw si SUB_HASH_PEPPER absent', () => {
    const prisma = makePrismaMock();
    expect(() => makeServiceWithPepper(prisma, undefined)).toThrow(
      /SUB_HASH_PEPPER/,
    );
  });

  it('throw si SUB_HASH_PEPPER < 32 chars', () => {
    const prisma = makePrismaMock();
    expect(() => makeServiceWithPepper(prisma, 'too-short')).toThrow(
      /SUB_HASH_PEPPER/,
    );
  });
});
