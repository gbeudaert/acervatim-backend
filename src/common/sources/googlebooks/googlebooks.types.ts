/**
 * Sous-ensemble de la réponse Google Books `GET /books/v1/volumes` réellement consommé :
 * on ne lit que les liens d'images du premier volume correspondant à l'ISBN.
 * Doc : https://developers.google.com/books/docs/v1/reference/volumes
 */
export interface GoogleBooksImageLinks {
  smallThumbnail?: string;
  thumbnail?: string;
  small?: string;
  medium?: string;
  large?: string;
  extraLarge?: string;
}

export interface GoogleBooksVolume {
  volumeInfo?: {
    /** 200$a côté Google — titre commercial FR (ex "Jujutsu Kaisen T06"), pour le repli par titre. */
    title?: string;
    /**
     * Métadonnées de série Google. `bookDisplayNumber` = n° de tome affiché ("6") — signal
     * STRUCTURÉ, plus fiable que d'extraire le tome du titre. Absent des romans/artbooks, ce qui
     * les écarte naturellement. (`seriesId` distingue les séries/éditions mais l'ISBN scanné n'en
     * porte pas, donc inexploitable comme ancre — cf. étude scripts/study-covers.ts.)
     */
    seriesInfo?: {
      bookDisplayNumber?: string;
    };
    /** Résumé Google Books du volume (souvent le résumé de série côté FR) — repli du résumé par tome. */
    description?: string;
    imageLinks?: GoogleBooksImageLinks;
  };
}

export interface GoogleBooksVolumesResponse {
  items?: GoogleBooksVolume[];
}

// ---------- Contrat de résolution de jaquette (partagé producteur / worker) ----------

/** Nom de la file BullMQ des résolutions Google Books (throttle sortant + single-flight). */
export const GBOOKS_QUEUE = 'gbooks';

/** Nom du job dans la file `gbooks`. */
export const GBOOKS_COVER_JOB = 'cover';

// Une jaquette est stable ; une absence peut être comblée plus tard (nouvelle notice Google).
export const HIT_TTL_SECONDS = 90 * 24 * 3600;
export const MISS_TTL_SECONDS = 7 * 24 * 3600;

/**
 * TTL du cache **négatif d'échec dur** (réseau / 4xx / 5xx après retries) : bien plus court qu'un
 * MISS 2xx (absence confirmée par Google), car un échec est transitoire — une vague 429/503 dure
 * quelques minutes. Il borne juste le ré-enqueue par de nouveaux scans pendant la vague (la file
 * `gbooks` est throttlée, cf. incident prod 0.6.2 : les mêmes ISBN se ré-enfilaient à chaque scan et
 * saturaient la file), puis expire vite pour laisser une jaquette réellement disponible réapparaître.
 * Couvre l'horizon de retry BullMQ (~3,75 min) + un peu de marge.
 */
export const FAIL_TTL_SECONDS = 10 * 60;

/**
 * Signaux BnF permettant le **repli par titre** quand l'ISBN scanné (édition papier Ki-oon) n'a
 * pas de jaquette chez Google Books : ces notices papier n'existent souvent qu'en fiche
 * catalographique sans image, alors que le même tome porte une jaquette sous une autre notice
 * (retrouvable par `intitle:<série> T<n>`).
 */
export interface CoverHint {
  /** Titre de la **série** (BnF `seriesTitle`/`titleFr`), pas le titre du tome. */
  title?: string | null;
  /** N° de tome dans l'édition, pour cibler la bonne notice illustrée. */
  volume?: number | null;
  /**
   * Mention d'édition BnF (205$a, ex "Éd. colossale"), null = édition standard. La jaquette DOIT
   * correspondre à l'édition : une Colossale et la série standard partagent titre+n° de tome mais
   * ont des couvertures différentes.
   */
  edition?: string | null;
}

/**
 * Issue d'une résolution de jaquette — tri-état exposé jusqu'à l'app pour lever l'ambiguïté du `null` :
 *  - `found`      : jaquette résolue (`coverUrl` non-null).
 *  - `absent`     : Google Books n'a PAS de jaquette pour ce tome (2xx sans notice illustrée qui
 *                   matche tome+édition, ou ISBN invalide/absent) → **définitif**, l'app peut afficher
 *                   « pas de couverture » sans re-tenter.
 *  - `unresolved` : non déterminé (503/réseau après retries, Redis indisponible, ou pas encore résolu
 *                   côté cache) → **transitoire**, à re-tenter (le worker réchauffe en arrière-plan).
 */
export type CoverStatus = 'found' | 'absent' | 'unresolved';

/** Jaquette + résumé d'un tome, résolus en un seul appel Google Books. */
export interface CoverResult {
  coverUrl: string | null;
  description: string | null;
  status: CoverStatus;
}

/**
 * Enveloppe de cache : distingue « ISBN jamais résolu » (absent du cache) de
 * « résolu, pas de jaquette » (`{ url: null }`), pour ne pas re-taper Google Books à chaque fois.
 * `status` porte le tri-état ({@link CoverStatus}) ; absent des entrées écrites avant la 0.6.4, il est
 * alors ré-inféré à la lecture (`url` présent → `found`, sinon → `absent`).
 */
export interface CachedCover {
  url: string | null;
  description?: string | null;
  status?: CoverStatus;
}

/** Ré-infère le {@link CoverStatus} d'une entrée de cache (compat entrées pré-0.6.4 sans `status`). */
export function cachedStatus(hit: CachedCover): CoverStatus {
  return hit.status ?? (hit.url ? 'found' : 'absent');
}

/** Payload d'un job `gbooks:cover` : ISBN **déjà normalisé** + hint BnF optionnel. */
export interface CoverJobData {
  isbn: string;
  hint: CoverHint | null;
}

/** ISBN-10/13 ou EAN → forme normalisée (chiffres + X), ou null si trop court pour être un ISBN. */
export function normalizeIsbn(isbn: string): string | null {
  const norm = isbn.replace(/[^0-9Xx]/g, '').toUpperCase();
  return norm.length >= 10 ? norm : null;
}

export function coverCacheKey(normIsbn: string): string {
  return `gbooks:cover:${normIsbn}`;
}
