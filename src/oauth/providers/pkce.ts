import { createHash, randomBytes } from 'crypto';

/**
 * Helpers PKCE (RFC 7636) pour OAuth 2.0.
 *
 * MAL utilise UNIQUEMENT `code_challenge_method=plain` — c'est-à-dire que le challenge
 * EST le verifier. C'est non-standard mais c'est la doc officielle MAL.
 * Cf. https://myanimelist.net/blog.php?eid=835707
 *
 * Pour les autres providers OAuth 2.0 (futur), on utilisera S256 par défaut.
 */

/** Génère un code_verifier conforme RFC 7636 §4.1 : 43-128 chars unreserved. */
export function generateCodeVerifier(byteLength = 64): string {
  // base64url(64 bytes) = 86 chars (sans padding), bien dans la fenêtre 43-128.
  return base64urlEncode(randomBytes(byteLength));
}

/** S256 : base64url(sha256(verifier)). Standard pour la plupart des OAuth 2.0 modernes. */
export function codeChallengeS256(verifier: string): string {
  return base64urlEncode(createHash('sha256').update(verifier).digest());
}

/** plain : verifier === challenge. Particularité MAL. */
export function codeChallengePlain(verifier: string): string {
  return verifier;
}

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
