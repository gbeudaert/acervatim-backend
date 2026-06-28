import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCacheService } from '../../cache/api-cache.service';
import { HttpClientService } from '../../http/http-client.service';
import { TokenBucketService } from '../../rate-limit/token-bucket.service';
import { BnfAuthor, BnfNotice, BnfResolution } from './bnf.types';
import {
  allDatafields,
  controlfield,
  firstSubfield,
  parseUnimarc,
  subfieldOf,
  UnimarcRecord,
} from './unimarc.parser';

const DEFAULT_BASE_URL = 'https://catalogue.bnf.fr/api/SRU';
const NOTICE_CACHE_TTL_SECONDS = 30 * 24 * 3600; // notices biblio quasi immuables.

// Throttle global poli (BnF ne publie pas de quota strict, mais c'est un service public).
const RATE_LIMIT_BUCKET = 'bnf:global';
const RATE_LIMIT_CAPACITY = 20;
const RATE_LIMIT_REFILL_PER_SEC = 5;

/**
 * Client BnF SRU + extraction UNIMARC → `BnfNotice`.
 *
 * Étape A+B du pipeline ISBN→MAL (cf. docs/interne/CONTEXT_isbn_to_mal.md).
 * Logging volontairement verbeux sur : ce qu'on parse, ce qu'on extrait, et les
 * séries détectées « en cours » (données de comptage partielles).
 */
@Injectable()
export class BnfService implements OnModuleInit {
  private readonly logger = new Logger(BnfService.name);
  private baseUrl = DEFAULT_BASE_URL;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
    private readonly cache: ApiCacheService,
    private readonly bucket: TokenBucketService,
  ) {}

  onModuleInit() {
    this.baseUrl =
      this.config.get<string>('BNF_SRU_BASE_URL') ?? DEFAULT_BASE_URL;
  }

  /**
   * Résout un ISBN (EAN-13 / ISBN-10/13) en notice BnF normalisée.
   * Ne jette pas sur "non trouvé" : renvoie un `Result` pour propagation propre.
   */
  async resolveByIsbn(isbn: string): Promise<BnfResolution> {
    const normIsbn = isbn.replace(/[^0-9Xx]/g, '');

    const allowed = await this.bucket.consume(
      RATE_LIMIT_BUCKET,
      RATE_LIMIT_CAPACITY,
      RATE_LIMIT_REFILL_PER_SEC,
    );
    if (!allowed) {
      this.logger.warn(`bnf: rate limited isbn=${normIsbn}`);
      return { ok: false, reason: 'bnf_rate_limited' };
    }

    // `bib.fuzzyISBN` accepte ISBN-10/13 et EAN indifféremment (cf. brief).
    const params = new URLSearchParams({
      version: '1.2',
      operation: 'searchRetrieve',
      recordSchema: 'unimarcxchange',
      maximumRecords: '3',
      query: `bib.fuzzyISBN all "${normIsbn}"`,
    });
    const url = `${this.baseUrl}?${params.toString()}`;
    const cacheKey = `bnf:isbn:${normIsbn}`;

    let xml: string;
    try {
      xml = await this.cache.getOrFetch<string>(
        cacheKey,
        NOTICE_CACHE_TTL_SECONDS,
        async () => {
          const res = await this.http.request<string>(url, { method: 'GET' });
          return typeof res.data === 'string' ? res.data : String(res.data);
        },
      );
    } catch {
      this.logger.warn(`bnf: SRU fetch failed isbn=${normIsbn}`);
      return { ok: false, reason: 'bnf_unavailable' };
    }

    let parsed;
    try {
      parsed = parseUnimarc(xml);
    } catch {
      this.logger.warn(`bnf: unparsable response isbn=${normIsbn}`);
      return { ok: false, reason: 'bnf_unparsable' };
    }

    this.logger.log(
      `bnf: parsing isbn=${normIsbn} numberOfRecords=${parsed.numberOfRecords} parsed=${parsed.records.length}`,
    );

    if (parsed.records.length === 0) {
      this.logger.warn(`bnf: not found isbn=${normIsbn}`);
      return { ok: false, reason: 'bnf_not_found' };
    }

    const notice = this.extractNotice(parsed.records[0], normIsbn);
    this.logNotice(notice);
    return { ok: true, notice };
  }

  private extractNotice(rec: UnimarcRecord, isbn: string): BnfNotice {
    const originalFrom454 = firstSubfield(rec, '454', 't');
    const originalFrom500 = firstSubfield(rec, '500', 'a');
    const originalTitle = originalFrom454 ?? originalFrom500 ?? null;
    const originalTitleSource = originalFrom454
      ? '454$t'
      : originalFrom500
        ? '500$a'
        : null;

    const publicationDate =
      firstSubfield(rec, '210', 'd') ?? firstSubfield(rec, '214', 'd') ?? null;

    return {
      isbn,
      ark: controlfield(rec, '003') ?? null,
      titleFr: firstSubfield(rec, '200', 'a') ?? null,
      volume: firstSubfield(rec, '200', 'h') ?? null,
      edition: firstSubfield(rec, '205', 'a') ?? null,
      publisherFr:
        firstSubfield(rec, '210', 'c') ??
        firstSubfield(rec, '214', 'c') ??
        null,
      seriesTitle: firstSubfield(rec, '225', 'a') ?? null,
      originalTitle,
      originalTitleSource,
      sourceVolumeRange: normalizeVolumeRange(firstSubfield(rec, '454', 'h')),
      authors: extractAuthors(rec),
      publicationDate,
      ongoing: isOngoing(publicationDate),
    };
  }

  private logNotice(n: BnfNotice): void {
    this.logger.log(
      [
        `bnf: extracted isbn=${n.isbn}`,
        `titleFr=${quote(n.titleFr)}`,
        `vol=${n.volume ?? '-'}`,
        `edition=${quote(n.edition)}`,
        `publisherFr=${quote(n.publisherFr)}`,
        `originalTitle=${quote(n.originalTitle)}[${n.originalTitleSource ?? 'none'}]`,
        `454h=${quote(n.sourceVolumeRange)}`,
        `author=${quote(n.authors[0]?.surname ?? n.authors[0]?.full)}`,
      ].join(' '),
    );

    if (!n.originalTitle) {
      this.logger.warn(
        `bnf: NO original title (454$t/500$a absent) isbn=${n.isbn} -> pivot MAL impossible, fallback bnf_only`,
      );
    }
    if (n.ongoing) {
      this.logger.warn(
        `bnf: serie likely ONGOING isbn=${n.isbn} date=${quote(n.publicationDate)} -> comptage de tomes / 454$h potentiellement partiels`,
      );
    }
  }
}

function extractAuthors(rec: UnimarcRecord): BnfAuthor[] {
  const authors: BnfAuthor[] = [];
  for (const df of [
    ...allDatafields(rec, '700'),
    ...allDatafields(rec, '701'),
  ]) {
    const surname = subfieldOf(df, 'a');
    const given = subfieldOf(df, 'b');
    if (surname || given) {
      authors.push({
        surname,
        given,
        full: [given, surname].filter(Boolean).join(' ') || undefined,
      });
    }
  }
  if (authors.length === 0) {
    const f = firstSubfield(rec, '200', 'f');
    if (f) authors.push({ full: f });
  }
  return authors;
}

/** "vol. 1-3" / "T. 1-3" / "1-3" → "1-3". null si rien d'exploitable. */
function normalizeVolumeRange(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/vol\.?|tomes?|t\.?/gi, '')
    .replace(/\s+/g, '')
    .trim();
  return /\d/.test(cleaned) ? cleaned : null;
}

/** Date ouverte type "2015-" / "DL 2015-" → série en cours. */
function isOngoing(date: string | null): boolean {
  if (!date) return false;
  return /\d{4}\s*-\s*$/.test(date.trim());
}

function quote(s: string | null | undefined): string {
  return s ? `"${s}"` : '-';
}
