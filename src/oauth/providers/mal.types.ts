/**
 * File BullMQ des appels MyAnimeList (throttle sortant global, remplace les buckets `mal:<userId>`
 * et `acervatim:mal`). Contrairement à TMDB, MAL a deux mécanismes d'accès selon le jeton résolu :
 *  - jeton user → header `Authorization: Bearer <token>` ;
 *  - repli premium → header `X-MAL-CLIENT-ID <MAL_CLIENT_ID serveur>` (données publiques).
 * Le choix du header et l'injection du secret se font **dans le worker** (cf. `MalProcessor`) : ni le
 * Bearer ni le client-id ne transitent par Redis.
 *
 * Le bucket **par-user** `mal:<userId>` (60/min) est supprimé, pas remplacé : l'anti-abus repose
 * désormais sur le `@nestjs/throttler` entrant (100/min/IP) et, pour les appels Bearer, sur le quota
 * que MAL applique déjà au jeton de l'utilisateur. Le limiter de file protège le credential partagé
 * (X-MAL-CLIENT-ID Acervatim) ; les appels BYOT héritent de la même borne — rouvrable en P3.
 */
export const MAL_QUEUE = 'mal';

/** Nom du job (GET MAL → JSON). */
export const MAL_FETCH_JOB = 'get';

/**
 * Payload d'un job MAL. L'URL est **sans header d'auth** : le worker résout le jeton à partir du
 * `userId` (Bearer user ou X-MAL-CLIENT-ID serveur) et l'injecte à l'appel — aucun secret dans Redis.
 */
export interface MalFetchJobData {
  userId: string;
  /** URL MAL complète (le header `Authorization`/`X-MAL-CLIENT-ID` est ajouté par le worker). */
  url: string;
}
