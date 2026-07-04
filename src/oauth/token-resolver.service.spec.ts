import { PremiumService, PremiumStatus } from '../premium/premium.service';
import { DecryptedCredentials, OauthCredentialsService } from './oauth.service';
import { TokenResolverService } from './token-resolver.service';

const FREE_STATUS: PremiumStatus = {
  isPremium: false,
  source: 'none',
  expiresAt: null,
};
const PREMIUM_STATUS: PremiumStatus = {
  isPremium: true,
  source: 'grant',
  expiresAt: null,
};

const USER_CREDS: DecryptedCredentials = {
  accessToken: 'user-token',
  refreshToken: 'user-refresh',
  expiresAtMs: 0,
  scopes: [],
};

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

function makeCredentialsMock(
  creds: DecryptedCredentials | null = null,
): OauthCredentialsService {
  return {
    get: jest.fn().mockResolvedValue(creds),
  } as unknown as OauthCredentialsService;
}

function makePremiumMock(status: PremiumStatus = FREE_STATUS): PremiumService {
  return {
    getStatus: jest.fn().mockResolvedValue(status),
  } as unknown as PremiumService;
}

function makeService(
  credentials: OauthCredentialsService,
  premium: PremiumService,
): TokenResolverService {
  return new TokenResolverService(credentials, premium);
}

describe('TokenResolverService.resolve', () => {
  it('renvoie le jeton utilisateur quand il est présent (non-premium)', async () => {
    const credentials = makeCredentialsMock(USER_CREDS);
    const premium = makePremiumMock(FREE_STATUS);
    const result = await makeService(credentials, premium).resolve(
      USER,
      'discogs',
    );

    expect(result).toEqual({ source: 'user', credentials: USER_CREDS });
    // Court-circuit : pas besoin d'interroger le statut premium.
    expect(premium.getStatus).not.toHaveBeenCalled();
  });

  it('renvoie le jeton utilisateur quand il est présent (premium)', async () => {
    const result = await makeService(
      makeCredentialsMock(USER_CREDS),
      makePremiumMock(PREMIUM_STATUS),
    ).resolve(USER, 'mal');

    expect(result).toEqual({ source: 'user', credentials: USER_CREDS });
  });

  it('replie sur les jetons Acervatim quand premium sans jeton user', async () => {
    const result = await makeService(
      makeCredentialsMock(null),
      makePremiumMock(PREMIUM_STATUS),
    ).resolve(USER, 'mal');

    expect(result).toEqual({ source: 'fallback' });
  });

  it('renvoie none quand non-premium sans jeton user', async () => {
    const result = await makeService(
      makeCredentialsMock(null),
      makePremiumMock(FREE_STATUS),
    ).resolve(USER, 'tmdb');

    expect(result).toEqual({ source: 'none' });
  });

  it('transmet userId et provider aux dépendances', async () => {
    const credentials = makeCredentialsMock(null);
    const premium = makePremiumMock(FREE_STATUS);
    await makeService(credentials, premium).resolve(USER, 'tmdb');

    expect(credentials.get).toHaveBeenCalledWith(USER, 'tmdb');
    expect(premium.getStatus).toHaveBeenCalledWith(USER);
  });
});
