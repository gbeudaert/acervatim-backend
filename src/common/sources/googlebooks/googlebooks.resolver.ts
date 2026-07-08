import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClientService } from '../../http/http-client.service';
import {
  CoverHint,
  CoverResult,
  GoogleBooksImageLinks,
  GoogleBooksVolume,
  GoogleBooksVolumesResponse,
  normalizeIsbn,
} from './googlebooks.types';

const BASE_URL = 'https://www.googleapis.com/books/v1/volumes';

/**
 * Résolution **réseau** d'une jaquette Google Books par ISBN — sans cache ni throttle : ces
 * responsabilités sont portées, respectivement, par {@link GoogleBooksCoverService} (cache +
 * enqueue) et le limiter BullMQ du {@link GoogleBooksProcessor}. Ce resolver ne fait QUE l'appel
 * HTTP et le choix du bon volume.
 *
 * **Ne rattrape pas les erreurs** : un échec HTTP (réseau / 4xx / 5xx après retries) est propagé.
 * C'est voulu — le worker distingue ainsi un 2xx (mis en cache, même sans image = absence
 * légitime) d'un échec transitoire (jamais mis en cache, re-tenté au prochain scan).
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
    if (!norm) return { coverUrl: null, description: null };

    let chosen = await this.fetchVolumeByIsbn(norm);
    if (!coverOf(chosen) && hint?.title && hint.volume != null) {
      chosen =
        (await this.fetchVolumeByTitle(
          hint.title,
          hint.volume,
          hint.edition ?? null,
        )) ?? chosen;
    }

    return { coverUrl: coverOf(chosen), description: descriptionOf(chosen) };
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
    );
    const wantSeries = normalizeTitle(seriesTitle);
    const wantEdition = editionKeyword(edition);
    for (const item of items) {
      if (!coverOf(item)) continue;
      if (volumeOf(item) !== volume) continue;
      if (editionOf(item, wantSeries) !== (wantEdition ?? '')) continue;
      return item;
    }
    return undefined;
  }

  /** Appel Google Books commun (clé API + country=FR), renvoie les volumes de la réponse. */
  private async queryVolumes(
    q: string,
    maxResults?: number,
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

    const res = await this.http.request<GoogleBooksVolumesResponse>(
      `${BASE_URL}?${params.toString()}`,
      { method: 'GET' },
    );
    return res.data?.items ?? [];
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
