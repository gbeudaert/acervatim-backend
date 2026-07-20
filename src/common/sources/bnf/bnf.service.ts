import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents } from 'bullmq';
import { createHash } from 'crypto';
import { ApiCacheService } from '../../cache/api-cache.service';
import {
  BNF_FETCH_JOB,
  BNF_PRIORITY_BACKGROUND,
  BNF_PRIORITY_INTERACTIVE,
  BNF_QUEUE,
  BnfAuthor,
  BnfFetchJobData,
  BnfNotice,
  BnfResolution,
  EditionMapping,
  EditionTome,
} from './bnf.types';
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
const EDITION_CACHE_TTL_SECONDS = 7 * 24 * 3600; // une édition peut gagner des tomes.
// Une notice par tome, mais le titre matche aussi le bruit (standard + collector +
// spin-offs + guides + rééditions) : un titre populaire dépasse largement 100 notices.
const EDITION_PAGE_SIZE = 100; // par requête SRU.
// Plafond cumulé sur toutes les pages (garde-fou BnF contre un titre pathologique).
// La pagination s'arrête de toute façon dès `all.length >= total` : une petite série
// ne paie pas ce plafond, seules les grosses en profitent. 400 tronquait des séries
// courantes — Dragon Ball remonte 536 notices (toutes éditions + spin-offs + guides),
// dont des tomes standard au-delà de la 400ᵉ étaient silencieusement perdus. 1000 =
// 10 pages max, priorité background, cachées 7 jours.
const EDITION_MAX_RECORDS = 1000;

// Plafond d'attente d'un fetch SRU (via la file `bnf`) avant d'abandonner (best-effort). Le SRU
// peut être lent ; on laisse de la marge, l'appelant gère l'échec (bnf_unavailable).
const BNF_WAIT_MS = 20_000;

/**
 * Client BnF SRU + extraction UNIMARC → `BnfNotice`.
 *
 * Étape A+B du pipeline ISBN→MAL (cf. docs/interne/CONTEXT_isbn_to_mal.md).
 * Logging volontairement verbeux sur : ce qu'on parse, ce qu'on extrait, et les
 * séries détectées « en cours » (données de comptage partielles).
 */
@Injectable()
export class BnfService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BnfService.name);
  private baseUrl = DEFAULT_BASE_URL;
  private queueEvents!: QueueEvents;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: ApiCacheService,
    @InjectQueue(BNF_QUEUE)
    private readonly queue: Queue<BnfFetchJobData, string>,
  ) {}

  onModuleInit() {
    this.baseUrl =
      this.config.get<string>('BNF_SRU_BASE_URL') ?? DEFAULT_BASE_URL;
    this.queueEvents = new QueueEvents(BNF_QUEUE, {
      connection: {
        host: this.config.get<string>('REDIS_HOST', 'localhost'),
        port: this.config.get<number>('REDIS_PORT', 6379),
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents?.close();
  }

  /**
   * Fetch d'une URL SRU **via la file `bnf`** (throttle sortant global + single-flight par URL).
   * `priority` : {@link BNF_PRIORITY_INTERACTIVE} pour un scan, {@link BNF_PRIORITY_BACKGROUND} pour
   * l'énumération. Jette si le worker échoue / Redis indisponible / timeout — l'appelant traduit en
   * `bnf_unavailable` (best-effort).
   */
  private async fetchSru(url: string, priority: number): Promise<string> {
    const jobId = `bnf:sru:${createHash('sha1').update(url).digest('hex')}`;
    const job = await this.queue.add(
      BNF_FETCH_JOB,
      { url },
      {
        jobId,
        priority,
        removeOnComplete: { age: 60, count: 500 },
        removeOnFail: true,
      },
    );
    return job.waitUntilFinished(this.queueEvents, BNF_WAIT_MS);
  }

  /**
   * Résout un ISBN (EAN-13 / ISBN-10/13) en notice BnF normalisée.
   * Ne jette pas sur "non trouvé" : renvoie un `Result` pour propagation propre.
   */
  async resolveByIsbn(isbn: string): Promise<BnfResolution> {
    const normIsbn = isbn.replace(/[^0-9Xx]/g, '');

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
        () => this.fetchSru(url, BNF_PRIORITY_INTERACTIVE),
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

  /**
   * Énumère TOUS les tomes d'une édition (« récupérer toute la série d'un coup »).
   * Recherche par titre FR + filtre sur l'édition (205), dédup par n° de tome.
   * Best-effort : le catalogue est bruité (rééditions, guides, séries en cours) —
   * on loggue le bruit et on renvoie ce qui est exploitable.
   *
   * @param titleFr  titre FR de la série (ex "L'attaque des titans")
   * @param edition  mention d'édition 205 (ex "Éd. colossale") ; null = édition standard
   */
  async enumerateEdition(
    titleFr: string,
    edition: string | null = null,
  ): Promise<EditionMapping> {
    const empty: EditionMapping = {
      titleFr,
      edition,
      tomeCount: 0,
      tomes: [],
      recordsScanned: 0,
      ongoing: false,
    };

    const { records, total, complete } =
      await this.fetchEditionRecords(titleFr);
    if (records.length === 0) return empty;

    const wantEdition = normalizeEdition(edition);
    const wantSeries = normalizeSeriesKey(titleFr);

    const byVolume = new Map<number, EditionTome>();
    let ongoing = false;
    for (const rec of records) {
      // Appartenance à la série : le catalogage BnF varie (461$t « fait partie de »,
      // sinon 225$a collection, sinon 200$a). Exclut les spin-offs et homonymes qui
      // matchent le titre mais ne sont pas la même série (ex "…: Before the Fall").
      const recSeries = normalizeSeriesKey(
        firstSubfield(rec, '461', 't') ??
          firstSubfield(rec, '225', 'a') ??
          firstSubfield(rec, '200', 'a') ??
          null,
      );
      if (recSeries !== wantSeries) continue;

      const rec205 = normalizeEdition(firstSubfield(rec, '205', 'a') ?? null);
      if (rec205 !== wantEdition) continue; // mauvaise édition (ou standard vs collector)

      // N° de tome : 461$v (ensemble) → 225$v (collection) → 200$h. Certains éditeurs
      // (Ki-oon) ne mettent PAS le n° en 200$h mais en 225$v/461$v — le lire seul
      // ne remontait qu'un tome.
      const volume = parseVolume(
        firstSubfield(rec, '461', 'v') ??
          firstSubfield(rec, '225', 'v') ??
          firstSubfield(rec, '200', 'h'),
      );
      if (volume === null) continue; // pas un tome numéroté → bruit (guide, intégrale…)

      if (!byVolume.has(volume)) {
        byVolume.set(volume, {
          editionVolume: volume,
          sourceVolumeRange: normalizeVolumeRange(
            firstSubfield(rec, '454', 'h'),
          ),
          isbn: firstSubfield(rec, '010', 'a') ?? null,
          titleFr: firstSubfield(rec, '200', 'a') ?? null,
          // 330$a — résumé propre au tome (souvent absent) ; repli Google Books côté search.
          description: firstSubfield(rec, '330', 'a') ?? null,
        });
      }
      const date =
        firstSubfield(rec, '210', 'd') ??
        firstSubfield(rec, '214', 'd') ??
        null;
      if (isOngoing(date)) ongoing = true;
    }

    const tomes = [...byVolume.values()].sort(
      (a, b) => a.editionVolume - b.editionVolume,
    );

    this.logger.log(
      `bnf: edition title="${titleFr}" edition="${edition ?? 'standard'}" recordsScanned=${records.length} numberOfRecords=${total} tomesKept=${tomes.length}${complete ? '' : ' TRUNCATED'}${ongoing ? ' ONGOING' : ''}`,
    );
    if (tomes.length === 0) {
      this.logger.warn(
        `bnf: edition NO tome matched title="${titleFr}" edition="${edition ?? 'standard'}" (titre/edition introuvables ou catalogage non exploitable)`,
      );
    }
    if (!complete) {
      this.logger.warn(
        `bnf: edition TRUNCATED title="${titleFr}" recordsScanned=${records.length}/${total} (plafond EDITION_MAX_RECORDS=${EDITION_MAX_RECORDS}) -> tomes potentiellement manquants`,
      );
    }
    if (ongoing) {
      this.logger.warn(
        `bnf: edition ONGOING title="${titleFr}" -> tomeCount potentiellement incomplet`,
      );
    }

    return {
      titleFr,
      edition,
      tomeCount: tomes.length,
      tomes,
      recordsScanned: records.length,
      ongoing,
    };
  }

  /**
   * Récupère TOUTES les notices BnF d'un titre via pagination SRU (`startRecord`).
   * Un seul page de 100 ne suffit pas pour un titre populaire (standard + collector
   * + spin-offs + guides) : les tomes catalogués au-delà étaient silencieusement
   * perdus. Best-effort : `complete=false` si on s'arrête sur plafond/erreur/quota.
   */
  private async fetchEditionRecords(titleFr: string): Promise<{
    records: UnimarcRecord[];
    total: number;
    complete: boolean;
  }> {
    const all: UnimarcRecord[] = [];
    let total = 0;
    let complete = true;
    let startRecord = 1; // SRU est indexé à partir de 1.

    while (startRecord <= EDITION_MAX_RECORDS) {
      const params = new URLSearchParams({
        version: '1.2',
        operation: 'searchRetrieve',
        recordSchema: 'unimarcxchange',
        maximumRecords: String(EDITION_PAGE_SIZE),
        startRecord: String(startRecord),
        query: `bib.title all "${titleFr}"`,
      });
      const url = `${this.baseUrl}?${params.toString()}`;
      const cacheKey = `bnf:edition-page:${titleFr.toLowerCase()}:${startRecord}`;

      let xml: string;
      try {
        xml = await this.cache.getOrFetch<string>(
          cacheKey,
          EDITION_CACHE_TTL_SECONDS,
          () => this.fetchSru(url, BNF_PRIORITY_BACKGROUND),
        );
      } catch {
        this.logger.warn(
          `bnf: edition fetch failed title="${titleFr}" startRecord=${startRecord}`,
        );
        complete = false;
        break;
      }

      const parsed = parseUnimarc(xml);
      if (parsed.numberOfRecords > 0) total = parsed.numberOfRecords;
      all.push(...parsed.records);

      if (parsed.records.length === 0) break; // plus de notices à récupérer.
      if (all.length >= total) break; // tout récupéré (selon le serveur).
      startRecord += parsed.records.length;
    }

    if (all.length < total) complete = false; // plafond atteint avant la fin.
    return { records: all, total, complete };
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
      seriesTitle:
        firstSubfield(rec, '461', 't') ??
        firstSubfield(rec, '225', 'a') ??
        firstSubfield(rec, '200', 'a') ??
        null,
      originalTitle,
      originalTitleSource,
      sourceVolumeRange: normalizeVolumeRange(firstSubfield(rec, '454', 'h')),
      noteFr: firstSubfield(rec, '330', 'a') ?? null,
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

/** Clé de série normalisée (minuscules, sans accents ni ponctuation) pour comparer
 * l'appartenance : "Maid sama !" et "Maid sama" → "maid sama". */
function normalizeSeriesKey(raw: string | null): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "Éd. colossale" → "colossale" ; null/standard → "". Pour comparer les éditions. */
function normalizeEdition(raw: string | null): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\b(ed|edition)\.?\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "1" → 1 ; "31" → 31 ; "T. 5" → 5 ; non numérique → null. */
function parseVolume(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/\d+/);
  return m ? Number(m[0]) : null;
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
