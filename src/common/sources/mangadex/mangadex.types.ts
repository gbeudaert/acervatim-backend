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

/** Payload de la file MangaDex — discriminé par `job.name` ({@link MANGADEX_COVERS_JOB} / IDENTIFY). */
export type MangaDexJobData = MangaDexCoversJobData | MangaDexIdentifyJobData;

/** Résultat de la file MangaDex : couvertures de série, ou entrée d'identité cachable. */
export type MangaDexJobResult =
  | MangaDexSeriesCovers
  | MangaDexIdentityCacheEntry;

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
