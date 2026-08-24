// ---------- File BullMQ des fetch SRU (throttle sortant, remplace le bucket bnf:global) ----------

/** File BullMQ des requêtes SRU BnF. `concurrency: 2` : un lookup interactif trouve toujours un slot
 * libre même pendant une énumération de fond (la priorité ne préempte pas un job en cours). */
export const BNF_QUEUE = 'bnf';

/** Nom du job (fetch d'une URL SRU → XML). */
export const BNF_FETCH_JOB = 'sru';

/** Priorité BullMQ (plus petit = plus prioritaire). Le lookup par ISBN (scan) passe devant
 * l'énumération d'édition (tâche de fond). */
export const BNF_PRIORITY_INTERACTIVE = 1;
export const BNF_PRIORITY_BACKGROUND = 10;

/** Payload d'un job `bnf:sru` : l'URL SRU complète à récupérer. */
export interface BnfFetchJobData {
  url: string;
}

/** Auteur tel que catalogué en notice BnF (700/701 structuré, ou 200$f libre). */
export interface BnfAuthor {
  /** 700$a — nom de famille. Signal fort pour le rapprochement MAL. */
  surname?: string;
  /** 700$b — prénom. */
  given?: string;
  /** Forme complète (200$f, ou "prénom nom" recomposé). */
  full?: string;
}

/** Notice BnF normalisée — sortie de l'étape A+B du pipeline ISBN→MAL. */
export interface BnfNotice {
  isbn: string;
  /** Identifiant pérenne BnF (controlfield 003), ou null. */
  ark: string | null;
  /** 200$a — titre de l'édition française. */
  titleFr: string | null;
  /** 200$h — numéro de tome (brut, ex "1", "31"). */
  volume: string | null;
  /** 205$a — mention d'édition (ex "Éd. colossale"). null = édition standard. */
  edition: string | null;
  /** 210$c | 214$c — éditeur de l'édition FR. */
  publisherFr: string | null;
  /**
   * Titre de la **série** FR, pour énumérer tous les tomes et nommer la série.
   * Source : `461$t` (lien « fait partie de », fiable) → `225$a` (collection) →
   * `titleFr` (200$a) en dernier recours. Distinct de `titleFr` qui, chez certains
   * éditeurs (Ki-oon), porte le titre du **tome** (ex "Je vais te tuer") et non de la série.
   */
  seriesTitle: string | null;
  /** 454$t (fallback 500$a) — titre original (romaji), pont vers MAL. */
  originalTitle: string | null;
  /** Zone d'où provient `originalTitle`, pour audit. */
  originalTitleSource: '454$t' | '500$a' | null;
  /** 454$h normalisé — plage de tomes source couverte (ex "1-3" pour une Colossale). */
  sourceVolumeRange: string | null;
  /** 330$a — note de résumé (en français quand présente). Souvent absente pour les mangas. */
  noteFr: string | null;
  authors: BnfAuthor[];
  /** 210$d | 214$d — date de publication brute. */
  publicationDate: string | null;
  /** Heuristique : série probablement en cours (date ouverte "2015-") → données partielles. */
  ongoing: boolean;
}

export type BnfFailureReason =
  | 'bnf_not_found'
  | 'bnf_unparsable'
  | 'bnf_rate_limited'
  | 'bnf_unavailable';

export type BnfResolution =
  | { ok: true; notice: BnfNotice }
  | { ok: false; reason: BnfFailureReason };

/** Un tome d'une édition, vu par la BnF. */
export interface EditionTome {
  /** 200$h — n° de tome dans l'édition (ex 1 pour Colossale T.1). */
  editionVolume: number;
  /** 454$h normalisé — tomes de l'édition source couverts (ex "1-3"). */
  sourceVolumeRange: string | null;
  /** 010$a — ISBN du tome. */
  isbn: string | null;
  /** 200$a — titre FR. */
  titleFr: string | null;
  /**
   * 330$a — note de résumé **propre au tome** (en français quand présente). Souvent absente pour
   * les mangas ; c'est la source primaire du résumé par tome (repli Google Books côté search).
   */
  description: string | null;
}

/** Mapping complet d'une édition (énumération BnF « toute la série d'un coup »). */
export interface EditionMapping {
  /** Titre FR recherché. */
  titleFr: string;
  /** Édition ciblée (205), ou null pour l'édition standard. */
  edition: string | null;
  /** Nombre de tomes de CETTE édition (ex 12 pour la Colossale), dérivé. */
  tomeCount: number;
  /** Tomes ordonnés par n° d'édition. */
  tomes: EditionTome[];
  /**
   * Auteurs de la série (700/701 agrégés sur les tomes énumérés, dédupliqués). Sert à **valider par
   * l'auteur** le rapprochement MangaDex des jaquettes quand aucun `mangaId`/`malId` n'est fourni
   * (chemin bnf_only) — le titre seul peut matcher une variante (édition colorisée…), l'auteur tranche.
   */
  authors: BnfAuthor[];
  /** Notices BnF parcourues (pour audit du bruit). */
  recordsScanned: number;
  /** Au moins une notice en cours de publication → mapping potentiellement partiel. */
  ongoing: boolean;
}
