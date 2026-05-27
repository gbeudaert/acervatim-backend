import { createHash } from 'crypto';
import {
  codeChallengePlain,
  codeChallengeS256,
  generateCodeVerifier,
} from './pkce';

describe('generateCodeVerifier', () => {
  it('produit une chaîne de 43-128 chars (fenêtre RFC 7636)', () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });

  it("n'utilise QUE des chars URL-safe (A-Z a-z 0-9 - _)", () => {
    for (let i = 0; i < 10; i++) {
      const v = generateCodeVerifier();
      expect(v).toMatch(/^[A-Za-z0-9\-_]+$/);
    }
  });

  it('génère une valeur différente à chaque appel (entropie réelle)', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });
});

describe('codeChallengeS256', () => {
  it('match la formule base64url(sha256(verifier)) — vecteur RFC 7636 §B', () => {
    // Vecteur de test officiel du RFC 7636 appendix B.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(codeChallengeS256(verifier)).toBe(expected);
  });

  it("ne contient pas de padding '=' ni de chars non URL-safe", () => {
    const c = codeChallengeS256(generateCodeVerifier());
    expect(c).not.toContain('=');
    expect(c).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('est déterministe (anti-régression algo)', () => {
    const v = 'static-verifier';
    const expected = createHash('sha256')
      .update(v)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(codeChallengeS256(v)).toBe(expected);
  });
});

describe('codeChallengePlain (MAL)', () => {
  it('renvoie le verifier inchangé (particularité MAL)', () => {
    const v = generateCodeVerifier();
    expect(codeChallengePlain(v)).toBe(v);
  });
});
