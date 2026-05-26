import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { AesService } from './aes.service';

function makeService(): AesService {
  const key = randomBytes(32).toString('base64');
  const config = { get: (k: string) => (k === 'ENCRYPTION_KEY' ? key : undefined) } as ConfigService;
  const svc = new AesService(config);
  svc.onModuleInit();
  return svc;
}

describe('AesService', () => {
  it('round-trip un plaintext UTF-8', () => {
    const svc = makeService();
    const plain = 'Hello, accentué é € 漢';
    const ct = svc.encrypt(plain);
    expect(svc.decrypt(ct)).toBe(plain);
  });

  it('produit un IV différent à chaque chiffrement', () => {
    const svc = makeService();
    const a = svc.encrypt('same');
    const b = svc.encrypt('same');
    expect(a).not.toBe(b);
  });

  it('détecte le tampering du ciphertext', () => {
    const svc = makeService();
    const ct = svc.encrypt('payload');
    const buf = Buffer.from(ct, 'base64');
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => svc.decrypt(tampered)).toThrow();
  });

  it('refuse une clé qui ne fait pas 32 bytes', () => {
    const config = {
      get: (k: string) => (k === 'ENCRYPTION_KEY' ? Buffer.alloc(16).toString('base64') : undefined),
    } as ConfigService;
    const svc = new AesService(config);
    expect(() => svc.onModuleInit()).toThrow(/32 bytes/);
  });
});
