import { OauthProvider } from '../oauth.service';

/**
 * Contrat pour l'aspect "flux d'autorisation" d'un provider.
 * Distinct du `SourceAdapter` (recherche/lecture) pour que TMDB — qui n'a pas d'OAuth user —
 * puisse implémenter `SourceAdapter` seul sans avoir à fournir start/callback.
 */
export interface OAuthFlowProvider {
  readonly provider: OauthProvider;

  /** Démarre le flux et renvoie l'URL d'autorisation à ouvrir côté app. */
  start(userId: string): Promise<{ authorizeUrl: string }>;

  /**
   * Termine le flux à partir du retour Discogs/MAL.
   * Le provider est responsable de :
   *  - retrouver/valider le contexte (userId + secret en cache)
   *  - échanger contre l'access token
   *  - persister via OauthCredentialsService
   * Retourne le userId résolu (utile car le callback est non-authentifié et la
   * résolution se fait via le cache du request token).
   */
  callback(query: Record<string, string>): Promise<{ userId: string }>;
}
