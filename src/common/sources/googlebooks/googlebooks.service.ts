import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCacheService } from '../../cache/api-cache.service';
import { HttpClientService } from '../../http/http-client.service';
import { TokenBucketService } from '../../rate-limit/token-bucket.service';
import { GoogleBooksVolumesResponse } from './googlebooks.types';

const BASE_URL = 'https://www.googleapis.com/books/v1/volumes';

// Une jaquette est stable ; une absence peut être comblée plus tard (nouvelle notice Google).
const HIT_TTL_SECONDS = 90 * 24 * 3600;
const MISS_TTL_SECONDS = 7 * 24 * 3600;

// Throttle poli pour rester sous le quota Google Books (par défaut ~1000 req/jour).
const RATE_LIMIT_BUCKET = 'gbooks:global';
const RATE_LIMIT_CAPACITY = 100;
const RATE_LIMIT_REFILL_PER_SEC = 1;

/**
 * Enveloppe de cache : distingue « ISBN jamais résolu » (absent du cache) de
 * « résolu, pas de jaquette » (`{ url: null }`), pour ne pas re-taper Google Books à chaque fois.
 */
interface CachedCover {
  url: string | null;
}

/**
 * Résolution de jaquette **par ISBN** via Google Books — seule source d'illustration par
 * tome/volume (la BnF est bibliographique, MAL ne fournit qu'un visuel de série). Utilisé pour
 * enrichir l'énumération d'édition manga (cf. issue backend#1) et par l'endpoint `/v1/search/cover`.
 *
 * Best-effort : ne jette jamais — renvoie `null` en cas d'échec réseau, de rate limit ou d'absence
 * de jaquette, pour ne pas casser les flux appelants.
 */
@Injectable()
export class GoogleBooksCoverService {
  private readonly logger = new Logger(GoogleBooksCoverService.name);
  private warnedMissingKey = false;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
    private readonly cache: ApiCacheService,
    private readonly bucket: TokenBucketService,
  ) {}

  /**
   * Lecture **cache-only** (jamais de réseau) : renvoie la jaquette déjà résolue pour cet ISBN,
   * `null` si absente du cache ou résolue sans image. Utilisé par `edition-mapping` pour rester rapide.
   */
  async cachedCover(isbn: string): Promise<string | null> {
    const norm = normalizeIsbn(isbn);
    if (!norm) return null;
    const hit = await this.cache.get<CachedCover>(cacheKey(norm));
    return hit?.url ?? null;
  }

  /**
   * Résout la jaquette par ISBN via Google Books (réseau, best-effort) et met le résultat en cache
   * (positif ET négatif). Un hit de cache court-circuite l'appel réseau.
   */
  async resolveCover(isbn: string): Promise<string | null> {
    const norm = normalizeIsbn(isbn);
    if (!norm) return null;

    const key = cacheKey(norm);
    const cached = await this.cache.get<CachedCover>(key);
    if (cached) return cached.url;

    const allowed = await this.bucket.consume(
      RATE_LIMIT_BUCKET,
      RATE_LIMIT_CAPACITY,
      RATE_LIMIT_REFILL_PER_SEC,
    );
    if (!allowed) {
      this.logger.warn(`gbooks: rate limited isbn=${norm}`);
      return null; // pas de mise en cache : on retentera au prochain appel.
    }

    let url: string | null;
    try {
      url = await this.fetchCover(norm);
    } catch {
      this.logger.warn(`gbooks: fetch failed isbn=${norm}`);
      return null; // échec réseau → pas de cache négatif (on retentera).
    }

    await this.cache.set<CachedCover>(
      key,
      { url },
      url ? HIT_TTL_SECONDS : MISS_TTL_SECONDS,
    );
    return url;
  }

  private async fetchCover(normIsbn: string): Promise<string | null> {
    const params = new URLSearchParams({
      q: `isbn:${normIsbn}`,
      country: 'FR',
    });
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
    const links = res.data?.items?.[0]?.volumeInfo?.imageLinks;
    const raw = links?.thumbnail ?? links?.smallThumbnail;
    return raw ? toHttpsCover(raw) : null;
  }
}

/** ISBN-10/13 ou EAN → forme normalisée (chiffres + X), ou null si trop court pour être un ISBN. */
function normalizeIsbn(isbn: string): string | null {
  const norm = isbn.replace(/[^0-9Xx]/g, '').toUpperCase();
  return norm.length >= 10 ? norm : null;
}

function cacheKey(normIsbn: string): string {
  return `gbooks:cover:${normIsbn}`;
}

/**
 * Google renvoie souvent l'URL en `http://` et avec un effet de page (`&edge=curl`) :
 * on force `https://` et on retire le curl pour une jaquette propre.
 */
function toHttpsCover(url: string): string {
  return url.replace(/^http:\/\//i, 'https://').replace(/&edge=curl/i, '');
}
