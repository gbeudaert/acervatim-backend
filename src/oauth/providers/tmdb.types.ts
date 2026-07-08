/**
 * File BullMQ des appels TMDB (throttle sortant global, remplace les buckets `tmdb:global` et
 * `acervatim:tmdb`). TMDB n'a pas de limite par-user à respecter côté fournisseur (c'est l'IP du
 * backend qui est limitée) : un unique limiter de file suffit.
 */
export const TMDB_QUEUE = 'tmdb';

/** Nom du job (GET TMDB → JSON). */
export const TMDB_FETCH_JOB = 'get';

/**
 * Payload d'un job TMDB. L'URL est **sans clé API** : la clé (perso BYOT ou serveur Acervatim) est
 * résolue **dans le worker** à partir du `userId` et injectée à l'appel — elle ne transite donc
 * jamais par Redis.
 */
export interface TmdbFetchJobData {
  userId: string;
  /** URL TMDB complète SAUF le paramètre `api_key` (ajouté par le worker). */
  url: string;
}
