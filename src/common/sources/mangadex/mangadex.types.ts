import { createHash } from 'crypto';
import { BnfAuthor } from '../bnf/bnf.types';

/**
 * Résolveur de jaquettes **par série + n° de tome** (MangaDex), complémentaire de Google Books qui,
 * lui, résout par ISBN. Les ISBN papier FR (Ki-oon, Kana, Glénat…) sont mal indexés par Google/Open
 * Library (couverture mesurée ~20-33 %) ; MangaDex, indexé par série, couvre ~80 % des tomes des
 * séries reconnues, avec souvent la jaquette de l'édition **française** (locale `fr`).
 *
 * Join fiable : chaque manga MangaDex expose `attributes.links.mal` = l'id MyAnimeList. Le pivot
 * ISBN→MAL résolvant déjà le `mal_id`, on retrouve le manga SANS matching flou.
 */

/** File BullMQ des résolutions MangaDex (throttle sortant + single-flight par série). */
export const MANGADEX_QUEUE = 'mangadex';

/** Nom du job : résout TOUTES les couvertures d'une série d'un coup (unité naturelle MangaDex). */
export const MANGADEX_COVERS_JOB = 'series-covers';

/**
 * Priorité BullMQ (plus petit = plus prioritaire), sur le modèle de la file `bnf`. La file est
 * sérialisée (concurrence 1, ~4 req/s) : sans priorité, une recherche saisie par l'utilisateur
 * attendait derrière le réchauffage des jaquettes de tout un import. Interactif : recherche, lecture
 * par id, identification du scan ; fond : jaquettes par série (worker d'import, rattrapage). Toutes
 * les entrées portent une priorité — BullMQ sert les jobs sans priorité avant les autres.
 */
export const MANGADEX_PRIORITY_INTERACTIVE = 1;
export const MANGADEX_PRIORITY_BACKGROUND = 10;

/**
 * Nom du job : **identifie** un manga (pivot BnF→MangaDex). Recherche par titre + désambiguïsation
 * titre/auteur → identité complète (méta + `links.mal`/`links.al` + synopsis multi-langue +
 * jaquettes par tome). C'est le chemin nominal du scan manga (MAL n'est plus qu'un repli).
 */
export const MANGADEX_IDENTIFY_JOB = 'identify';

// Une jaquette de tome est stable ; une absence/non-match peut être comblée plus tard (nouvelle
// entrée MangaDex, mal_id enfin fourni) → TTL plus court côté absence.
export const HIT_TTL_SECONDS = 30 * 24 * 3600;
export const MISS_TTL_SECONDS = 3 * 24 * 3600;
/** Cache négatif d'échec dur (réseau / 5xx) — court, borne le ré-enqueue pendant une vague. */
export const FAIL_TTL_SECONDS = 10 * 60;

/**
 * Préférence de locale d'une couverture : l'édition **française** d'abord (jaquette qui matche le
 * tome papier scanné), sinon l'originale japonaise, sinon anglaise, sinon n'importe laquelle.
 */
export const LOCALE_PREFERENCE = ['fr', 'ja', 'en'];

/** Couverture d'un tome : URL de la miniature + locale de l'édition d'où elle provient. */
export interface MangaDexVolumeCover {
  url: string;
  locale: string;
}

/**
 * Couvertures d'une série, indexées par n° de tome (clé = `String(numéro)`), + l'id MangaDex retenu
 * et le tri-état (aligné sur {@link CoverStatus} Google) :
 *  - `found`      : série trouvée, au moins une jaquette de tome ;
 *  - `absent`     : 2xx mais série non trouvée / sans jaquette de tome exploitable (définitif) ;
 *  - `unresolved` : non déterminé (réseau/5xx après retries, Redis down, pas encore résolu).
 */
export interface MangaDexSeriesCovers {
  mangaId: string | null;
  volumes: Record<string, MangaDexVolumeCover>;
  status: 'found' | 'absent' | 'unresolved';
}

/**
 * Indices d'identification d'une série pour la résolution des jaquettes, par fiabilité décroissante :
 * `mangaId` (identité déjà connue au scan → join direct) > `malId` (join `links.mal`) > `authors`
 * (validation du match par titre, chemin bnf_only). Tous optionnels : sans indice exploitable, la
 * résolution MangaDex ressort `absent` et l'appelant résout les jaquettes par ISBN.
 */
export interface SeriesCoverLookup {
  mangaId: string | null;
  malId: string | null;
  authors: BnfAuthor[];
}

/** Payload d'un job `mangadex:series-covers` : titre de série + indices d'identification. */
export interface MangaDexCoversJobData extends SeriesCoverLookup {
  title: string;
}

/** Payload d'un job `mangadex:identify` : titre interrogé (romaji ou FR) + auteurs BnF (désambigu.). */
export interface MangaDexIdentifyJobData {
  query: string;
  authors: BnfAuthor[];
}

/**
 * Nom du job : **recherche texte** de séries (`GET /v1/search?type=manga&q=`), sans jeton. Une page
 * de candidats que l'utilisateur départage lui-même — aucun rapprochement automatique ici.
 */
export const MANGADEX_SEARCH_JOB = 'search';

/** Nom du job : lecture d'une série **par id** (identité du candidat choisi après une recherche). */
export const MANGADEX_SERIES_JOB = 'series';

/** Famille de mesure du cache de recherche (cf. `ApiCacheService.stats`), comme `discogs:search:q`. */
export const MANGADEX_SEARCH_FAMILY = 'mangadex:search';

// Une page de recherche bouge peu (nouvelles séries, suivis qui changent l'ordre) : un jour de cache
// mutualise les requêtes répétées sans servir une liste périmée. Une recherche vide peut se combler
// (titre ajouté, alt-titre FR saisi) : quelques heures seulement.
export const SEARCH_HIT_TTL_SECONDS = 24 * 3600;
export const SEARCH_MISS_TTL_SECONDS = 6 * 3600;

/**
 * Résumé d'une série MangaDex : ce qu'il faut pour la **choisir** (recherche) et pour en retrouver
 * les éditions françaises (titres FR/romaji/alt, auteurs). Plus léger qu'une {@link MangaDexIdentity}
 * (ni jaquettes par tome, ni note) : une recherche ne coûte qu'un appel.
 */
export interface MangaDexSeriesSummary {
  mangaId: string;
  /** Titre d'affichage : FR si dispo, sinon romaji, sinon premier titre. */
  title: string;
  titleFr: string | null;
  titleRomaji: string | null;
  /** Tous les libellés (titre principal + alt-titres, toutes langues), pour reconnaître les notices BnF. */
  altTitles: string[];
  authors: string[];
  coverUrl: string | null;
  descriptionFr: string | null;
  descriptionEn: string | null;
  malId: string | null;
  anilistId: string | null;
  /** `ongoing` | `completed` | `hiatus` | `cancelled`, ou null. */
  status: string | null;
  year: number | null;
  lastVolume: string | null;
  contentRating: string | null;
}

/** Une page de recherche MangaDex (offset/limit MangaDex, `total` annoncé par l'API). */
export interface MangaDexSearchPage {
  total: number;
  offset: number;
  limit: number;
  results: MangaDexSeriesSummary[];
}

/** Payload d'un job `mangadex:search`. */
export interface MangaDexSearchJobData {
  query: string;
  offset: number;
  limit: number;
}

/** Payload d'un job `mangadex:series` (lecture par id). */
export interface MangaDexSeriesJobData {
  mangaId: string;
}

/**
 * Entrée de cache d'une recherche : `page` à `null` = **échec dur** récent (`FAIL_TTL`), à ne pas
 * confondre avec une page vide (2xx, `results: []`).
 */
export interface MangaDexSearchCacheEntry {
  page: MangaDexSearchPage | null;
}

/**
 * Entrée de cache d'une série lue par id : `summary` à `null` = id inconnu de MangaDex (404) ;
 * `failed` = échec dur récent (`FAIL_TTL`), qui ne doit pas se lire comme une absence.
 */
export interface MangaDexSeriesCacheEntry {
  summary: MangaDexSeriesSummary | null;
  failed?: boolean;
}

/** Issue d'une lecture par id, côté appelant (`404` / `502` / données). */
export type MangaDexSeriesLookup =
  | { status: 'found'; summary: MangaDexSeriesSummary }
  | { status: 'absent' }
  | { status: 'unresolved' };

/** Payload de la file MangaDex — discriminé par `job.name`. */
export type MangaDexJobData =
  | MangaDexCoversJobData
  | MangaDexIdentifyJobData
  | MangaDexSearchJobData
  | MangaDexSeriesJobData;

/** Résultat de la file MangaDex : couvertures, identité, page de recherche ou série par id. */
export type MangaDexJobResult =
  | MangaDexSeriesCovers
  | MangaDexIdentityCacheEntry
  | MangaDexSearchCacheEntry
  | MangaDexSeriesCacheEntry;

/**
 * Identité MangaDex d'un manga (chemin nominal du scan). Fournit tout ce dont l'app a besoin sans
 * appeler MAL : synopsis FR, note, nb de tomes, genres, jaquettes par tome, et le **`malId`**
 * (`links.mal`) porté en metadata pour retrouver MAL trivialement plus tard (sync bibliothèque).
 */
export interface MangaDexIdentity {
  mangaId: string;
  /** Titre d'affichage : FR si dispo, sinon romaji/EN. */
  title: string;
  titleFr: string | null;
  titleRomaji: string | null;
  /** Synopsis `description.fr` (décisif pour un public FR — MAL n'a pas de synopsis FR). */
  descriptionFr: string | null;
  descriptionEn: string | null;
  /** `attributes.links.mal` — join direct vers MAL, sans recherche floue. */
  malId: string | null;
  /** `attributes.links.al` — AniList. */
  anilistId: string | null;
  /** `attributes.status` (ongoing/completed/hiatus/cancelled). */
  status: string | null;
  year: number | null;
  /** `attributes.lastVolume` (dernier tome connu, brut). */
  lastVolume: string | null;
  contentRating: string | null;
  /** Genres (tags de groupe `genre`). */
  genres: string[];
  /** Auteurs/artistes (relations `author`/`artist`), dédupliqués. */
  authors: string[];
  /** Jaquette principale du manga (relation `cover_art`). */
  coverUrl: string | null;
  /** Note bayésienne `/statistics` (best-effort, `null` si l'appel échoue/absent). */
  rating: number | null;
  /** Jaquettes par n° de tome (clé = `String(numéro)`), comme {@link MangaDexSeriesCovers.volumes}. */
  volumes: Record<string, MangaDexVolumeCover>;
  /** Confiance ∈ [0,1] du rapprochement. */
  confidence: number;
  /** Ce qui a validé le match : titre + auteur (fort) ou titre seul (fort). */
  matchedBy: 'title+author' | 'title';
  /**
   * Un AUTRE candidat de la recherche atteignait le même score de titre que celui retenu — le titre
   * seul ne suffisait donc pas à départager. Le chemin nominal (BnF) l'**ignore** : l'auteur de la
   * notice tranche. Le repli Google Books, lui, **rejette** l'identification quand `ambiguous` et
   * qu'aucun auteur n'a matché : c'est ce qui écarte *Frieren Cinnamoroll Kamigata* (crossover
   * parasite) sur la requête d'un seul token « Frieren », sans toucher au seuil `PIVOT_TITLE_STRONG`.
   */
  ambiguous: boolean;
}

/**
 * Entrée de cache d'identification : `identity` à `null` = « 2xx mais aucun manga identifié »
 * (négatif légitime, évite de re-chercher). Enveloppe nécessaire car un `get` renvoyant `null`
 * ne distingue pas « absent du cache » de « identifié : rien ».
 */
export interface MangaDexIdentityCacheEntry {
  identity: MangaDexIdentity | null;
}

/**
 * Clé de cache d'une identification, par requête (titre) normalisée. Version `v2` depuis l'ajout de
 * {@link MangaDexIdentity.ambiguous} : les entrées v1 ne portent pas le drapeau et seraient relues
 * comme « non ambiguë », ce qui rouvrirait le faux positif que le repli doit refuser. Le cache se
 * remplit de nouveau en quelques scans.
 */
export function identityCacheKey(query: string): string {
  const norm = query.trim().toLowerCase().replace(/\s+/g, ' ');
  return `mangadex:identify:v2:${norm}`;
}

/** jobId BullMQ d'une identification (sha1 : la requête peut contenir `:`/espaces). */
export function identityJobId(query: string): string {
  return createHash('sha1').update(identityCacheKey(query)).digest('hex');
}

/**
 * Clé de cache d'une série. Priorité au `mal_id` (identité stable, insensible aux variantes de
 * titre) ; repli sur le titre normalisé quand le mal_id est inconnu (chemin bnf_only).
 */
export function seriesCacheKey(malId: string | null, title: string): string {
  if (malId) return `mangadex:series:mal:${malId}`;
  const norm = title.trim().toLowerCase().replace(/\s+/g, ' ');
  return `mangadex:series:title:${norm}`;
}

/** jobId BullMQ (sha1 : la clé peut contenir `:`/espaces, interdits dans un jobId). */
export function seriesJobId(malId: string | null, title: string): string {
  return createHash('sha1').update(seriesCacheKey(malId, title)).digest('hex');
}

/**
 * Forme canonique d'une saisie de recherche : minuscules, sans accents ni ponctuation, espaces
 * compactés. Le texte libre se répète peu d'un utilisateur à l'autre (taux de hit 0,25 mesuré côté
 * Discogs) : fusionner « L'Attaque des Titans » et « l attaque des titans » est le seul gain gratuit.
 */
export function normalizeSearchQuery(query: string): string {
  return query
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Clé de cache d'une page de recherche (requête normalisée + offset + limit, sans userId). */
export function searchCacheKey(
  query: string,
  offset: number,
  limit: number,
): string {
  return `mangadex:search:v1:${normalizeSearchQuery(query)}:${offset}:${limit}`;
}

/** jobId BullMQ d'une recherche (single-flight sur la clé de cache). */
export function searchJobId(
  query: string,
  offset: number,
  limit: number,
): string {
  return createHash('sha1')
    .update(searchCacheKey(query, offset, limit))
    .digest('hex');
}

/** Clé de cache d'une série lue par id. */
export function seriesSummaryCacheKey(mangaId: string): string {
  return `mangadex:manga:v1:${mangaId}`;
}

/** jobId BullMQ d'une lecture par id. */
export function seriesSummaryJobId(mangaId: string): string {
  return createHash('sha1')
    .update(seriesSummaryCacheKey(mangaId))
    .digest('hex');
}
