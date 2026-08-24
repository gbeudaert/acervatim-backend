import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClientService } from '../../http/http-client.service';
import {
  CoverHint,
  CoverResult,
  GoogleBooksImageLinks,
  GoogleBooksVolume,
  GoogleBooksVolumesResponse,
  VolumeInfo,
  normalizeIsbn,
} from './googlebooks.types';

const BASE_URL = 'https://www.googleapis.com/books/v1/volumes';

/**
 * Tentatives HTTP du **repli `intitle:`** (requête décisive pour les ISBN papier FR). Google renvoie
 * des 503 INTERMITTENTS à taux élevé sur `/volumes` (mesuré ~50-60 %, l'appel suivant est souvent
 * 200) : un retry court (backoff HttpClientService 250/750/2250 ms) les absorbe, là où `maxAttempts:1`
 * les laissait tuer la résolution. La requête `isbn:`, elle, reste à 1 tentative (son échec retombe
 * désormais sur ce repli) ; les vagues 503 *soutenues* restent gérées par le backoff long job-level.
 */
const FALLBACK_QUERY_ATTEMPTS = 3;

/**
 * Tentatives HTTP du **titre par ISBN** (repli `Google Books → MangaDex`). Contrairement à la
 * jaquette, `isbn:` est ici la SEULE requête possible — il n'y a pas de repli `intitle:` derrière
 * (c'est précisément le titre qu'on cherche). Un 503 intermittent y coûterait tout le repli : on
 * retente comme sur `intitle:`.
 */
const VOLUME_INFO_ATTEMPTS = 3;

/**
 * Résolution **réseau** d'une jaquette Google Books par ISBN — sans cache ni throttle : ces
 * responsabilités sont portées, respectivement, par {@link GoogleBooksCoverService} (cache +
 * enqueue) et le limiter BullMQ du {@link GoogleBooksProcessor}. Ce resolver ne fait QUE l'appel
 * HTTP et le choix du bon volume.
 *
 * **Gestion d'erreur** : l'échec de la requête `isbn:` (best-effort) NE propage PAS tant qu'un repli
 * `intitle:` est possible (hint BnF présent) — les ISBN papier FR (Ki-oon…) n'ont de toute façon pas
 * de jaquette sur `isbn:`, et Google y renvoie des 503 intermittents ; laisser ce 503 avorter la
 * résolution privait ces séries de jaquette pendant des jours (Black Torch, SNK colossale). Un échec
 * du repli — ou de `isbn:` quand aucun repli n'est possible — est propagé : le worker distingue ainsi
 * un 2xx (mis en cache, même sans image = absence légitime) d'un échec transitoire (non caché, re-tenté).
 */
@Injectable()
export class GoogleBooksResolver {
  private readonly logger = new Logger(GoogleBooksResolver.name);
  private warnedMissingKey = false;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
  ) {}

  /**
   * Résout la jaquette (et le résumé) d'un tome. Deux étapes : (1) `q=isbn:<isbn>` ; (2) si cette
   * notice n'a pas d'image ET qu'un [hint] BnF (titre série + n° de tome) est fourni, repli
   * `intitle:<titre> T<n>` — l'édition papier FR n'a souvent qu'une fiche sans jaquette, l'image
   * vivant sous une autre notice du même tome.
   */
  async fetchCover(
    isbn: string,
    hint?: CoverHint | null,
  ): Promise<CoverResult> {
    const norm = normalizeIsbn(isbn);
    // ISBN invalide/trop court : aucune jaquette possible → absence définitive (pas un échec réseau).
    if (!norm) return { coverUrl: null, description: null, status: 'absent' };

    const canFallback = hint?.title != null && hint.volume != null;

    // La requête `isbn:` est un raccourci best-effort. Son échec (503 intermittent, réseau) ne doit
    // PAS court-circuiter le repli `intitle:` tant que celui-ci est possible — sinon les ISBN papier
    // FR, qui ne résolvent QUE par titre, ne récupèrent jamais de jaquette. Sans repli possible, on
    // propage (503 transitoire → non caché, re-tenté).
    let chosen: GoogleBooksVolume | undefined = undefined;
    try {
      chosen = await this.fetchVolumeByIsbn(norm);
    } catch (err) {
      if (!canFallback) throw err;
    }

    if (!coverOf(chosen) && hint?.title != null && hint.volume != null) {
      chosen =
        (await this.fetchVolumeByTitle(
          hint.title,
          hint.volume,
          hint.edition ?? null,
        )) ?? chosen;
    }

    // Ici la requête a abouti (2xx) : une URL → `found`, sinon Google n'a pas la jaquette → `absent`
    // (définitif). Un échec réseau/503 n'arrive JAMAIS ici — il a été propagé plus haut (→ le worker
    // le classera `unresolved`).
    const coverUrl = coverOf(chosen);
    return {
      coverUrl,
      description: descriptionOf(chosen),
      status: coverUrl ? 'found' : 'absent',
    };
  }

  /**
   * **Titre par ISBN** — maillon d'entrée du repli déclenché quand la BnF ne connaît pas l'ISBN
   * scanné (nouveauté non encore cataloguée, éditeur non français). Renvoie le titre commercial
   * brut, les auteurs quand Google les fournit (42 % des notices manga FR mesurées) et la date.
   *
   * `null` = 2xx sans notice exploitable (absence légitime, à cacher en MISS). Un échec réseau/503
   * **propage** : le worker le classera en cache négatif court et re-tentera.
   */
  async fetchVolumeInfo(isbn: string): Promise<VolumeInfo | null> {
    const norm = normalizeIsbn(isbn);
    if (!norm) return null;

    const items = await this.queryVolumes(
      `isbn:${norm}`,
      undefined,
      VOLUME_INFO_ATTEMPTS,
    );
    const info = items[0]?.volumeInfo;
    const title = info?.title?.trim();
    if (!title) return null;

    return {
      title,
      authors: (info?.authors ?? [])
        .map((a) => a.trim())
        .filter((a) => a.length > 0),
      publishedDate: info?.publishedDate?.trim() || null,
    };
  }

  /** `q=isbn:<isbn>` — volume de la notice correspondant exactement à l'ISBN, ou undefined. */
  private async fetchVolumeByIsbn(
    normIsbn: string,
  ): Promise<GoogleBooksVolume | undefined> {
    const items = await this.queryVolumes(`isbn:${normIsbn}`);
    return items[0];
  }

  /**
   * Repli par titre : `intitle:<série> T<volume>` (tome zéro-padté `T06`, comme imprimé sur les
   * couvertures FR), puis on retient la première notice **illustrée** qui satisfait STRICTEMENT le
   * bon tome (`seriesInfo.bookDisplayNumber` sinon n° extrait du titre) ET la bonne édition (titre
   * = `<série> [<édition>]` une fois le n° retiré ; les spin-offs et éditions étrangères tombent).
   */
  private async fetchVolumeByTitle(
    seriesTitle: string,
    volume: number,
    edition: string | null,
  ): Promise<GoogleBooksVolume | undefined> {
    // Zéro-padding ≥ 2 chiffres : Google matche le jeton imprimé « T06 », pas « T6 ».
    const token = `T${String(volume).padStart(2, '0')}`;
    const items = await this.queryVolumes(
      `intitle:${seriesTitle} ${token}`,
      40,
      FALLBACK_QUERY_ATTEMPTS,
    );
    const wantSeries = normalizeTitle(seriesTitle);
    const wantEdition = editionKeyword(edition);
    for (const item of items) {
      if (!coverOf(item)) continue;
      if (volumeOf(item) !== volume) continue;
      if (editionOf(item, wantSeries) !== (wantEdition ?? '')) continue;
      return item;
    }
    // Repli exécuté mais aucune notice illustrée ne satisfait tome+édition : Google n'a pas la
    // jaquette (trou de données), à distinguer d'un 503. On le trace pour l'analyse en prod.
    this.logger.log(
      `gbooks: intitle no-match title="${seriesTitle}" vol=${volume} edition="${edition ?? '-'}" items=${items.length}`,
    );
    return undefined;
  }

  /**
   * Appel Google Books commun (clé API + country=FR), renvoie les volumes de la réponse.
   * `maxAttempts` : 1 par défaut (requête `isbn:`, dont l'échec retombe désormais sur le repli) ;
   * {@link FALLBACK_QUERY_ATTEMPTS} pour le repli `intitle:` afin d'absorber les 503 intermittents.
   */
  private async queryVolumes(
    q: string,
    maxResults?: number,
    maxAttempts = 1,
  ): Promise<GoogleBooksVolume[]> {
    const params = new URLSearchParams({ q, country: 'FR' });
    if (maxResults) params.set('maxResults', String(maxResults));
    const apiKey = this.config.get<string>('GOOGLE_BOOKS_API_KEY');
    if (apiKey) {
      params.set('key', apiKey);
    } else if (!this.warnedMissingKey) {
      this.warnedMissingKey = true;
      this.logger.warn(
        'gbooks: GOOGLE_BOOKS_API_KEY absent — appels non authentifiés (quota réduit)',
      );
    }

    // Deux étages de retry complémentaires : ici en ~0,25-2 s pour les 503 INTERMITTENTS (repli
    // `intitle:`, maxAttempts>1) ; et le backoff exponentiel job-level (attempts:5, 15→120 s) de
    // GoogleBooksCoverService pour les vagues 503 *soutenues* pluri-minutes. La requête `isbn:`
    // reste à 1 tentative (son échec retombe sur le repli), pour ne pas gonfler un endpoint throttlé.
    // Trace requête + code retour : le HttpClientService masque la query dans ses WARN
    // (`redactedTarget`) — ce log rend visible CE qui a été demandé (isbn:/intitle: + valeurs) et son
    // issue (2xx+nb d'items, ou échec/503), pour distinguer 503 d'un trou de données côté Google.
    try {
      const res = await this.http.request<GoogleBooksVolumesResponse>(
        `${BASE_URL}?${params.toString()}`,
        { method: 'GET', maxAttempts },
      );
      const items = res.data?.items ?? [];
      this.logger.log(
        `gbooks: query q="${q}" -> ${res.status} items=${items.length}`,
      );
      return items;
    } catch (err) {
      this.logger.warn(
        `gbooks: query q="${q}" -> échec ${err instanceof Error ? err.message : 'erreur'}`,
      );
      throw err;
    }
  }
}

/** Jaquette (thumbnail ou repli smallThumbnail) d'un volume, normalisée https, ou null. */
function coverOf(volume: GoogleBooksVolume | undefined): string | null {
  const links: GoogleBooksImageLinks | undefined =
    volume?.volumeInfo?.imageLinks;
  const raw = links?.thumbnail ?? links?.smallThumbnail;
  return raw ? toHttpsCover(raw) : null;
}

/** Résumé d'un volume Google Books, trimé, ou null si absent/vide. */
function descriptionOf(volume: GoogleBooksVolume | undefined): string | null {
  const raw = volume?.volumeInfo?.description?.trim();
  return raw ? raw : null;
}

/**
 * Titre comparable : minuscules, sans accents ni ponctuation ; les tomes (`T0*n`, `Tome n`)
 * ramenés à `tn` ; espaces compactés. Ex : "L'Attaque des Titans — Tome 06" → "l attaque des titans t6".
 */
function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\btome\s*0*(\d+)\b/g, 't$1')
    .replace(/\bt0*(\d+)\b/g, 't$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Mots d'édition génériques ignorés dans la comparaison (« Éd. colossale » ≡ « Colossale »). */
const GENERIC_EDITION_WORDS = new Set(['ed', 'edition']);

/** Retire les mots d'édition génériques d'un libellé déjà normalisé. */
function stripGeneric(normalized: string): string {
  return normalized
    .split(' ')
    .filter((w) => w && !GENERIC_EDITION_WORDS.has(w))
    .join(' ');
}

/**
 * Mot-clé d'édition comparable tiré de la mention BnF (205$a). "Éd. colossale" → "colossale" ;
 * null/standard → null. Sert à exiger (édition spéciale) ou interdire (standard) la mention côté
 * jaquette Google Books.
 */
function editionKeyword(edition: string | null): string | null {
  if (!edition) return null;
  return stripGeneric(normalizeTitle(edition)) || null;
}

/**
 * N° de tome d'une notice : `seriesInfo.bookDisplayNumber` (structuré, fiable) en priorité, sinon
 * repli sur le n° extrait du titre. Renvoie null si aucun (→ la notice ne matchera aucun tome).
 */
function volumeOf(volume: GoogleBooksVolume): number | null {
  const display = volume.volumeInfo?.seriesInfo?.bookDisplayNumber;
  if (display != null) {
    const n = Number.parseInt(display, 10);
    if (Number.isFinite(n)) return n;
  }
  return extractVolume(normalizeTitle(volume.volumeInfo?.title ?? ''));
}

/**
 * Mention d'édition d'une notice, relative à la série voulue : ce qui reste du titre normalisé une
 * fois retirés le préfixe série et le jeton de tome, débarrassé des mots génériques. `""` = édition
 * standard ; `"colossale"` = Colossale ; `"before the fall"` = spin-off (donc rejeté). Renvoie une
 * sentinelle jamais égale à une édition attendue si le titre ne commence pas par la série.
 */
function editionOf(volume: GoogleBooksVolume, wantSeries: string): string {
  const title = normalizeTitle(volume.volumeInfo?.title ?? '');
  if (!title.startsWith(wantSeries)) return ' '; // titre hors série → jamais retenu
  return stripGeneric(
    title
      .slice(wantSeries.length)
      .replace(/\bt\d+\b/, '')
      .trim(),
  );
}

/** Extrait le n° de tome d'un titre normalisé (`… t6` → 6), ou null. */
function extractVolume(normalizedTitle: string): number | null {
  const m = /\bt(\d+)\b/.exec(normalizedTitle);
  return m ? Number(m[1]) : null;
}

/**
 * Google renvoie souvent l'URL en `http://` et avec un effet de page (`&edge=curl`) :
 * on force `https://` et on retire le curl pour une jaquette propre.
 */
function toHttpsCover(url: string): string {
  return url.replace(/^http:\/\//i, 'https://').replace(/&edge=curl/i, '');
}
