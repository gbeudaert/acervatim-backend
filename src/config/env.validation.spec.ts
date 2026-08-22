import { randomBytes } from 'crypto';
import { validateEnv } from './env.validation';

function baseConfig() {
  return {
    PORT: '3000',
    NODE_ENV: 'test',
    DATABASE_URL: 'mysql://u:p@db:3306/acervatim',
    SUB_HASH_PEPPER: 'x'.repeat(32),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    INVITE_CODE_PEPPER: 'y'.repeat(32),
    SHARE_CODE_PEPPER: 's'.repeat(32),
    ADMIN_API_TOKEN: 'z'.repeat(32),
    JWT_PRIVATE_KEY: 'pk',
    JWT_PUBLIC_KEY: 'pub',
    GOOGLE_CLIENT_ID: 'gid',
  };
}

describe('validateEnv', () => {
  it('accepte une configuration valide', () => {
    const env = validateEnv(baseConfig());
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('test');
  });

  it('rejette un SHARE_CODE_PEPPER absent', () => {
    const cfg = baseConfig() as Record<string, unknown>;
    delete cfg.SHARE_CODE_PEPPER;
    expect(() => validateEnv(cfg)).toThrow(/SHARE_CODE_PEPPER/);
  });

  it('rejette une ENCRYPTION_KEY trop courte', () => {
    const cfg = baseConfig();
    cfg.ENCRYPTION_KEY = randomBytes(16).toString('base64');
    expect(() => validateEnv(cfg)).toThrow(/ENCRYPTION_KEY/);
  });
});
