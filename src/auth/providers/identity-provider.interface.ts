/**
 * Contrat d'un fournisseur d'identité externe (Google, Apple, Facebook, …).
 *
 * Chaque fournisseur :
 *  - Connaît la forme de son credential (id_token JWT, access_token OAuth2, etc.) et le valide.
 *  - Retourne uniquement un `subject` opaque (stable, unique chez le provider).
 *  - Ne stocke RIEN en base : la persistance est centralisée par `IdentityResolverService`.
 *
 * Le `subject` retourné est ensuite haché (HMAC + pepper) avant toute écriture DB.
 * Aucun log du subject en clair.
 */
export interface IdentityProvider {
  /** Clé stable utilisée dans les routes (`/v1/auth/{name}`), les logs et l'audit. */
  readonly name: string;

  /**
   * Valide le credential reçu du client et retourne l'identité externe.
   * Doit throw `UnauthorizedException` (ou équivalent) si la validation échoue.
   * Ne log JAMAIS le subject brut ni le credential.
   */
  verify(credential: unknown): Promise<VerifiedIdentity>;
}

export interface VerifiedIdentity {
  /** Identifiant opaque du compte chez le provider (ex: Google `sub`). Jamais persisté en clair. */
  subject: string;
}

/** DI token pour l'injection multi-providers via `@Inject(IDENTITY_PROVIDERS)`. */
export const IDENTITY_PROVIDERS = Symbol('IDENTITY_PROVIDERS');
