import { AesService } from '../common/crypto/aes.service';
import { PrismaService } from '../prisma/prisma.service';
import { OauthCredentialsService } from './oauth.service';

type PrismaMock = {
  oauthCredential: {
    upsert: jest.Mock;
    findUnique: jest.Mock;
    deleteMany: jest.Mock;
    findMany: jest.Mock;
  };
};

function makePrismaMock(): PrismaMock {
  return {
    oauthCredential: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
  };
}

function makeAes(): AesService {
  // Round-trip vrai : encrypt prépend un préfixe et decrypt l'enlève.
  // Suffisant pour vérifier que le service délègue bien le crypto.
  const PREFIX = 'enc:';
  return {
    encrypt: jest.fn((plain: string) => `${PREFIX}${plain}`),
    decrypt: jest.fn((ct: string) => ct.replace(PREFIX, '')),
  } as unknown as AesService;
}

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

describe('OauthCredentialsService.store', () => {
  it('chiffre access + refresh tokens via AesService et upsert sur (userId, provider)', async () => {
    const prisma = makePrismaMock();
    const aes = makeAes();
    const svc = new OauthCredentialsService(
      prisma as unknown as PrismaService,
      aes,
    );

    await svc.store(USER, 'discogs', {
      accessToken: 'access-plain',
      refreshToken: 'refresh-plain',
      expiresAtMs: 1700000000000,
      scopes: ['read', 'write'],
    });

    expect(aes.encrypt).toHaveBeenCalledWith('access-plain');
    expect(aes.encrypt).toHaveBeenCalledWith('refresh-plain');
    expect(prisma.oauthCredential.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.oauthCredential.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      userId_provider: { userId: USER, provider: 'discogs' },
    });
    expect(call.create.accessTokenEncrypted).toBe('enc:access-plain');
    expect(call.create.refreshTokenEncrypted).toBe('enc:refresh-plain');
    expect(call.create.expiresAt).toBe(BigInt(1700000000000));
    expect(call.create.scopes).toEqual(['read', 'write']);
  });

  it('omet refresh quand absent (OAuth 1.0a)', async () => {
    const prisma = makePrismaMock();
    const aes = makeAes();
    const svc = new OauthCredentialsService(
      prisma as unknown as PrismaService,
      aes,
    );

    await svc.store(USER, 'discogs', {
      accessToken: 'access-plain',
      expiresAtMs: 0,
      scopes: [],
    });

    const call = prisma.oauthCredential.upsert.mock.calls[0][0];
    expect(call.create.refreshTokenEncrypted).toBeNull();
    expect(aes.encrypt).toHaveBeenCalledTimes(1);
  });
});

describe('OauthCredentialsService.get', () => {
  it('renvoie null si aucune ligne', async () => {
    const prisma = makePrismaMock();
    const aes = makeAes();
    prisma.oauthCredential.findUnique.mockResolvedValue(null);

    const svc = new OauthCredentialsService(
      prisma as unknown as PrismaService,
      aes,
    );
    expect(await svc.get(USER, 'discogs')).toBeNull();
  });

  it('déchiffre access + refresh et convertit expiresAt en number', async () => {
    const prisma = makePrismaMock();
    const aes = makeAes();
    prisma.oauthCredential.findUnique.mockResolvedValue({
      accessTokenEncrypted: 'enc:access-plain',
      refreshTokenEncrypted: 'enc:refresh-plain',
      expiresAt: BigInt(1700000000000),
      scopes: ['read'],
    });

    const svc = new OauthCredentialsService(
      prisma as unknown as PrismaService,
      aes,
    );
    const res = await svc.get(USER, 'discogs');
    expect(res).toEqual({
      accessToken: 'access-plain',
      refreshToken: 'refresh-plain',
      expiresAtMs: 1700000000000,
      scopes: ['read'],
    });
  });

  it('round-trip store → get retourne le plaintext exact (anti-régression crypto)', async () => {
    // Le sprint exige : store → get → access token décrypté égal au plaintext.
    const prisma = makePrismaMock();
    const aes = makeAes();
    const svc = new OauthCredentialsService(
      prisma as unknown as PrismaService,
      aes,
    );

    // Côté store on capture ce qui aurait été persisté…
    let persistedAccess = '';
    let persistedRefresh: string | null = null;
    prisma.oauthCredential.upsert.mockImplementation(async ({ create }) => {
      persistedAccess = create.accessTokenEncrypted;
      persistedRefresh = create.refreshTokenEncrypted;
    });

    await svc.store(USER, 'discogs', {
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
      expiresAtMs: 0,
      scopes: [],
    });

    // …puis on rejoue côté get avec la même ligne stockée.
    prisma.oauthCredential.findUnique.mockResolvedValue({
      accessTokenEncrypted: persistedAccess,
      refreshTokenEncrypted: persistedRefresh,
      expiresAt: BigInt(0),
      scopes: [],
    });
    const res = await svc.get(USER, 'discogs');

    expect(res?.accessToken).toBe('secret-access');
    expect(res?.refreshToken).toBe('secret-refresh');
    // Sanity check : le ciphertext doit différer du plaintext
    expect(persistedAccess).not.toBe('secret-access');
  });
});

describe('OauthCredentialsService.remove', () => {
  it('deleteMany scopé par userId + provider', async () => {
    const prisma = makePrismaMock();
    const svc = new OauthCredentialsService(
      prisma as unknown as PrismaService,
      makeAes(),
    );

    await svc.remove(USER, 'discogs');
    expect(prisma.oauthCredential.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, provider: 'discogs' },
    });
  });
});

describe('OauthCredentialsService.listConnected', () => {
  it('renvoie {provider, expiresAtMs} — jamais de token chiffré ni en clair', async () => {
    const prisma = makePrismaMock();
    prisma.oauthCredential.findMany.mockResolvedValue([
      { provider: 'discogs', expiresAt: BigInt(0) },
      { provider: 'mal', expiresAt: BigInt(1700000000000) },
    ]);

    const svc = new OauthCredentialsService(
      prisma as unknown as PrismaService,
      makeAes(),
    );
    const res = await svc.listConnected(USER);
    expect(res).toEqual([
      { provider: 'discogs', expiresAtMs: 0 },
      { provider: 'mal', expiresAtMs: 1700000000000 },
    ]);
    // Le select doit demander uniquement provider + expiresAt
    const call = prisma.oauthCredential.findMany.mock.calls[0][0];
    expect(call.select).toEqual({ provider: true, expiresAt: true });
  });
});
