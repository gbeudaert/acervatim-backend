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
  /** 225$a — collection (peut être l'œuvre OU une collection éditeur). */
  seriesTitle: string | null;
  /** 454$t (fallback 500$a) — titre original (romaji), pont vers MAL. */
  originalTitle: string | null;
  /** Zone d'où provient `originalTitle`, pour audit. */
  originalTitleSource: '454$t' | '500$a' | null;
  /** 454$h normalisé — plage de tomes source couverte (ex "1-3" pour une Colossale). */
  sourceVolumeRange: string | null;
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
