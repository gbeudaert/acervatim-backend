/**
 * File BullMQ des appels Discogs (throttle sortant global, remplace les buckets `discogs:<userId>`
 * et `acervatim:discogs`). Discogs authentifié plafonne à ~60 req/min par identité : le limiter de
 * file borne le débit sortant total, tous users confondus.
 *
 * Contrairement à TMDB (clé d'URL) et MAL (header simple), Discogs est en **OAuth 1.0a** : chaque
 * appel doit être **signé** (HMAC-SHA1 sur méthode + URL + params) avec le couple consumer + le
 * token/secret du demandeur. La signature est calculée **dans le worker** (cf. `DiscogsProcessor`) à
 * partir du `userId` : ni le consumer secret, ni le token user, ni le personal token Acervatim ne
 * transitent par Redis — seuls le `userId` et l'URL publique voyagent dans le payload du job.
 *
 * Le bucket **par-user** `discogs:<userId>` (60/min) est supprimé, pas remplacé : l'anti-abus repose
 * désormais sur le `@nestjs/throttler` entrant (100/min/IP) et, pour les appels signés avec le token
 * user, sur le quota que Discogs applique déjà à ce token. Le limiter de file protège le credential
 * partagé (consumer / personal token Acervatim) ; les appels BYOT héritent de la même borne —
 * rouvrable en P3.
 */
export const DISCOGS_QUEUE = 'discogs';

/** Nom du job (GET Discogs signé → JSON). */
export const DISCOGS_FETCH_JOB = 'get';

/**
 * Payload d'un job Discogs. L'URL est **complète mais non signée** : le worker résout le jeton à
 * partir du `userId`, signe l'appel (OAuth 1.0a user, ou consumer-only / `Discogs token=` pour le
 * repli premium) et pose le header `Authorization` — aucun secret dans Redis.
 */
export interface DiscogsFetchJobData {
  userId: string;
  /** URL Discogs complète (query params inclus) ; le header `Authorization` est ajouté par le worker. */
  url: string;
}
