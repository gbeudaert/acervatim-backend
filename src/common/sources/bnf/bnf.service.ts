import { InjectQueue } from '@nestjs/bullmq';
import {
  BadGatewayException,
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
  EditionSummary,
  EditionTome,
  EnumerateEditionOptions,
} from './bnf.types';
import {
  belongsToSeries,
  displayPublisher,
  dominantPublisher,
  EditionRecord,
  extractAuthors,
  firstSubfieldAmong,
  isOngoing,
  keepForDominant,
  matchesEdition,
  normalizeEdition,
  normalizePublisher,
  normalizeSeriesKey,
  normalizeVolumeRange,
  projectEditions,
  readEditionRecord,
  volumeOf,
} from './edition-records';
import {
  controlfield,
  firstSubfield,
  parseUnimarc,
  UnimarcRecord,
} from './unimarc.parser';

const DEFAULT_BASE_URL = 'https://catalogue.bnf.fr/api/SRU';
const NOTICE_CACHE_TTL_SECONDS = 30 * 24 * 3600; // notices biblio quasi immuables.
// TTL du cache **d'absence** (`numberOfRecords=0`). Une notice est quasi immuable, une absence ne
// l'est pas : le catalogage BnF traîne (dépôt légal) et les éditeurs FR non français (belges,
// suisses) n'y entrent parfois que tardivement — le TTL notice de 30 j gelait le scan d'une
// nouveauté un mois après son catalogage réel (ex 9782808703437, Vega-Dupuis, paru 05/2026).
// 24 h : une absence confirmée ne coûte au plus qu'un appel SRU par jour et par ISBN scanné,
// et la notice apparaît au plus tard le lendemain de son entrée au catalogue.
const NOT_FOUND_CACHE_TTL_SECONDS = 24 * 3600;
const EDITION_CACHE_TTL_SECONDS = 7 * 24 * 3600; // une édition peut gagner des tomes.
// Page d'énumération **vide** (0 notice) : comme l'absence d'un ISBN, elle n'est pas immuable — un
// titre absent aujourd'hui peut être catalogué demain. 7 jours la figeaient ; 24 h suffisent.
const EMPTY_EDITION_PAGE_TTL_SECONDS = NOT_FOUND_CACHE_TTL_SECONDS;
// Rattrapage (`since`) : la question posée est « quoi de neuf depuis telle date ? », rejouée au
// plus une fois par semaine et par série. Une demi-journée de cache absorbe les ouvertures
// répétées d'une même série sans retarder la découverte d'une notice de plus de 12 h.
const SINCE_CACHE_TTL_SECONDS = 12 * 3600;
// Requêtes BnF tentées pour lister les éditions d'une série (titre FR, saisie, romaji) : au-delà,
// on paierait des pages SRU pour des titres de plus en plus improbables.
const LIST_EDITIONS_MAX_QUERIES = 3;
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

    // Le TTL dépend de ce que le SRU renvoie (notice vs absence) : on ne peut donc pas le fixer
    // avant le fetch comme le ferait `getOrFetch` — on déroule get / fetch / parse / set.
    const cached = await this.cache.get<string>(cacheKey);
    let xml: string;
    if (cached !== null) {
      xml = cached;
    } else {
      try {
        xml = await this.fetchSru(url, BNF_PRIORITY_INTERACTIVE);
      } catch {
        this.logger.warn(`bnf: SRU fetch failed isbn=${normIsbn}`);
        return { ok: false, reason: 'bnf_unavailable' };
      }
    }

    const parsed = parseUnimarc(xml);
    if (!parsed.isSruResponse) {
      // Corps sans `<numberOfRecords>` : page d'erreur / diagnostic, pas une absence de notice.
      // Transitoire comme `bnf_unavailable`, donc jamais mis en cache — sinon un incident BnF de
      // dix minutes se figerait 24 h côté Acervatim.
      this.logger.warn(`bnf: unparsable response isbn=${normIsbn}`);
      return { ok: false, reason: 'bnf_unparsable' };
    }

    this.logger.log(
      `bnf: parsing isbn=${normIsbn} numberOfRecords=${parsed.numberOfRecords} parsed=${parsed.records.length}`,
    );

    const found = parsed.records.length > 0;
    if (cached === null) {
      await this.cache.set(
        cacheKey,
        xml,
        found ? NOTICE_CACHE_TTL_SECONDS : NOT_FOUND_CACHE_TTL_SECONDS,
      );
    }

    if (!found) {
      this.logger.warn(`bnf: not found isbn=${normIsbn}`);
      return { ok: false, reason: 'bnf_not_found' };
    }

    const notice = this.extractNotice(parsed.records[0], normIsbn);
    this.logNotice(notice);
    return { ok: true, notice };
  }

  /**
   * Énumère TOUS les tomes d'une édition (« récupérer toute la série d'un coup »).
   * Recherche par titre FR (texte imprimé seulement), puis filtre sur la série, l'édition (205) et
   * l'**éditeur**, dédup par n° de tome. Best-effort : le catalogue est bruité (rééditions, guides,
   * romans dérivés, séries en cours) — on loggue le bruit et on renvoie ce qui est exploitable.
   *
   * L'éditeur fait partie de l'identité d'une édition : sans lui, les 2-en-1 France Loisirs
   * (« 11-12 ») prenaient la place des tomes Pika de même numéro dans la « standard » de *L'attaque
   * des titans*. Non précisé, l'éditeur **dominant** gagne les collisions de n° (cf.
   * {@link keepForDominant}) ; précisé, le filtre est strict.
   *
   * @param titleFr  titre FR de la série (ex "L'attaque des titans")
   * @param edition  mention d'édition 205 (ex "Éd. colossale") ; null = édition standard
   * @param opts     `publisher` (sinon dominant) ; `since` AAAAMMJJ (rattrapage : notices créées
   *                 depuis cette date seulement)
   */
  async enumerateEdition(
    titleFr: string,
    edition: string | null = null,
    opts: EnumerateEditionOptions = {},
  ): Promise<EditionMapping> {
    const empty: EditionMapping = {
      titleFr,
      edition,
      publisher: null,
      tomeCount: 0,
      tomes: [],
      authors: [],
      recordsScanned: 0,
      ongoing: false,
      complete: true,
    };

    const fetched = await this.fetchEditionRecords(titleFr, opts.since);
    const { records, total } = fetched;
    // Une liste vide n'est une réponse que si la BnF a répondu : une première page en échec doit
    // rester distinguable de « aucun tome », sinon le rattrapage croirait la fenêtre vérifiée.
    let complete = fetched.complete;
    if (records.length === 0) return { ...empty, complete };

    const wantSeries = normalizeSeriesKey(titleFr);
    const wantEdition = normalizeEdition(edition);
    const members = records
      .map(readEditionRecord)
      .filter((r) => belongsToSeries(r, wantSeries));
    const inEdition = members.filter((r) =>
      matchesEdition(r, wantEdition, edition, wantSeries),
    );

    // Éditeur retenu : celui demandé (filtre strict), sinon le dominant, qui ne gagne que les
    // collisions de n° (cf. keepForDominant). En rattrapage (`since`), le sous-ensemble des notices
    // récentes ne dit rien de l'éditeur dominant (un seul 2-en-1 récent suffirait à le fausser) : on
    // le calcule sur l'énumération complète, servie par son propre cache.
    let publisherKey: string | null;
    let kept: EditionRecord[];
    if (opts.publisher !== undefined) {
      publisherKey = normalizePublisher(opts.publisher);
      kept = inEdition.filter((r) => r.publisherKey === publisherKey);
    } else {
      let reference = inEdition;
      if (opts.since) {
        const full = await this.fetchEditionRecords(titleFr);
        // L'éditeur dominant tiré d'une énumération tronquée peut être faux : le résultat aussi.
        complete = complete && full.complete;
        reference = full.records
          .map(readEditionRecord)
          .filter(
            (r) =>
              belongsToSeries(r, wantSeries) &&
              matchesEdition(r, wantEdition, edition, wantSeries),
          );
      }
      const dominant = dominantPublisher(reference, wantSeries);
      publisherKey = dominant.key;
      kept = inEdition.filter((r) => keepForDominant(r, wantSeries, dominant));
    }

    const byVolume = new Map<number, EditionTome>();
    // Auteurs de la série, agrégés sur les notices membres (toutes éditions confondues) et
    // dédupliqués : servent à valider par l'auteur le rapprochement MangaDex des jaquettes.
    const seriesAuthors = new Map<string, BnfAuthor>();
    for (const r of members) {
      for (const a of r.authors) {
        const key = normalizeSeriesKey(a.full ?? a.surname ?? a.given ?? '');
        if (key && !seriesAuthors.has(key)) seriesAuthors.set(key, a);
      }
    }
    let ongoing = false;
    const publishers: string[] = [];
    for (const r of kept) {
      const volume = volumeOf(r, wantSeries);
      if (volume === null) continue; // pas un tome numéroté → bruit (guide, intégrale…)
      if (r.publisher) publishers.push(r.publisher);
      if (!byVolume.has(volume)) byVolume.set(volume, toTome(r, volume));
      if (isOngoing(r.date)) ongoing = true;
    }

    const tomes = [...byVolume.values()].sort(
      (a, b) => a.editionVolume - b.editionVolume,
    );
    // Libellé de l'éditeur retenu (dominant ou demandé), pas celui d'un tome qui comble un trou.
    const publisher = displayPublisher(
      kept.find((r) => r.publisherKey === publisherKey)?.publisher ??
        publishers[0] ??
        null,
    );
    const otherPublishers = new Set(
      inEdition.map((r) => r.publisherKey).filter((k) => k !== publisherKey),
    ).size;

    this.logger.log(
      `bnf: edition title="${titleFr}" edition="${edition ?? 'standard'}" publisher="${publisher ?? '-'}"${opts.publisher === undefined ? ` (dominant, ${otherPublishers} autre(s) libelle(s) : collisions ecartees, trous combles)` : ''}${opts.since ? ` since=${opts.since}` : ''} recordsScanned=${records.length} numberOfRecords=${total} tomesKept=${tomes.length}${complete ? '' : ' TRUNCATED'}${ongoing ? ' ONGOING' : ''}`,
    );
    if (tomes.length === 0 && !opts.since) {
      this.logger.warn(
        `bnf: edition NO tome matched title="${titleFr}" edition="${edition ?? 'standard'}" publisher="${opts.publisher ?? '-'}" (titre/edition/editeur introuvables ou catalogage non exploitable)`,
      );
    }
    if (!complete) {
      this.logger.warn(
        `bnf: edition TRUNCATED title="${titleFr}" recordsScanned=${records.length}/${total} (plafond EDITION_MAX_RECORDS=${EDITION_MAX_RECORDS} ou page SRU en echec) -> tomes potentiellement manquants`,
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
      publisher,
      tomeCount: tomes.length,
      tomes,
      authors: [...seriesAuthors.values()],
      recordsScanned: records.length,
      ongoing,
      complete,
    };
  }

  /**
   * Liste les **éditions françaises** d'une série : projection sur les mêmes notices que
   * {@link enumerateEdition} (même requête, même cache), groupées par (série, éditeur, 205$a). Chaque
   * édition renvoyée se rejoue à l'identique dans `enumerateEdition(seriesTitleFr, edition,
   * { publisher })`.
   *
   * @param queryTitles titres à interroger, dans l'ordre (FR d'abord) ; on s'arrête au premier qui
   *                    produit au moins une édition
   * @param matchTitles tous les titres connus de la série (FR, romaji, alt-titres, saisie) : une
   *                    notice n'est retenue que si l'un de ses titres en égale un
   * @param authorNames auteurs de la série (MangaDex), pour écarter un homonyme catalogué
   *
   * `complete` = toutes les pages interrogées ont été lues. Si **aucune** notice n'a pu être lue et
   * qu'au moins une lecture a échoué, on lève une erreur passerelle (502) plutôt que de répondre
   * `editions: []` : l'app proposerait sinon la création manuelle d'une série que la BnF connaît
   * peut-être, au lieu de « réessayer ».
   */
  async listEditions(
    queryTitles: string[],
    matchTitles: string[],
    authorNames: string[],
  ): Promise<{ editions: EditionSummary[]; complete: boolean }> {
    const matchKeys = new Set(
      [...matchTitles, ...queryTitles]
        .map((t) => normalizeSeriesKey(t))
        .filter((k) => k.length > 0),
    );
    const tried = new Set<string>();
    let complete = true;
    let recordsRead = 0;
    for (const title of queryTitles) {
      const key = normalizeSeriesKey(title);
      if (!key || tried.has(key)) continue;
      if (tried.size >= LIST_EDITIONS_MAX_QUERIES) break;
      tried.add(key);

      const fetched = await this.fetchEditionRecords(title);
      complete = complete && fetched.complete;
      recordsRead += fetched.records.length;
      const editions = projectEditions(
        fetched.records.map(readEditionRecord),
        matchKeys,
        authorNames,
      );
      this.logger.log(
        `bnf: editions query="${title}" records=${fetched.records.length} editions=${editions.length}${fetched.complete ? '' : ' INCOMPLETE'}`,
      );
      if (editions.length > 0) return { editions, complete };
    }
    if (recordsRead === 0 && !complete) {
      this.logger.warn(
        `bnf: editions indisponibles queries=${tried.size} (aucune notice lue, lecture en echec) -> 502`,
      );
      throw new BadGatewayException('bnf: upstream unavailable');
    }
    return { editions: [], complete };
  }

  /**
   * Récupère TOUTES les notices BnF d'un titre via pagination SRU (`startRecord`).
   * Un seul page de 100 ne suffit pas pour un titre populaire (standard + collector
   * + spin-offs + guides) : les tomes catalogués au-delà étaient silencieusement
   * perdus. Best-effort : `complete=false` si on s'arrête sur plafond/erreur/quota.
   *
   * Requête restreinte au **texte imprimé** (`bib.doctype any "a"`) : le titre seul remonte aussi
   * DVD, CD et Blu-ray. `since` ajoute `bib.creationdate >= "AAAAMMJJ"` (format strict : une date
   * `AAAA-MM-JJ` renvoie 0 notice sans erreur). Le TTL dépend de la réponse — une page vide n'est
   * gardée que 24 h, comme l'absence d'un ISBN —, d'où le déroulé get / fetch / parse / set plutôt
   * que `getOrFetch`.
   */
  private async fetchEditionRecords(
    titleFr: string,
    since?: string,
  ): Promise<{
    records: UnimarcRecord[];
    total: number;
    complete: boolean;
  }> {
    const all: UnimarcRecord[] = [];
    let total = 0;
    let complete = true;
    let startRecord = 1; // SRU est indexé à partir de 1.
    const title = cqlPhrase(titleFr);
    const query =
      `bib.title all "${title}" and bib.doctype any "a"` +
      (since ? ` and bib.creationdate >= "${since}"` : '');

    while (startRecord <= EDITION_MAX_RECORDS) {
      const params = new URLSearchParams({
        version: '1.2',
        operation: 'searchRetrieve',
        recordSchema: 'unimarcxchange',
        maximumRecords: String(EDITION_PAGE_SIZE),
        startRecord: String(startRecord),
        query,
      });
      const url = `${this.baseUrl}?${params.toString()}`;
      // v2 : la requête porte désormais le filtre `doctype` — les pages v1 (sans filtre) ne
      // correspondent plus à la même question.
      const cacheKey = since
        ? `bnf:edition-since:v1:${titleFr.toLowerCase()}:${since}:${startRecord}`
        : `bnf:edition-page:v2:${titleFr.toLowerCase()}:${startRecord}`;

      // Lecture cache + fetch dans le même try : une panne du cache (base indisponible) dégrade
      // l'énumération en `complete=false`, comme une page SRU en échec, au lieu d'une 500.
      let cached: string | null;
      let xml: string;
      try {
        cached = await this.cache.get<string>(cacheKey);
        xml = cached ?? (await this.fetchSru(url, BNF_PRIORITY_BACKGROUND));
      } catch {
        this.logger.warn(
          `bnf: edition fetch failed title="${titleFr}" startRecord=${startRecord}`,
        );
        complete = false;
        break;
      }

      const parsed = parseUnimarc(xml);
      if (!parsed.isSruResponse) {
        // Page d'erreur / diagnostic : transitoire, jamais mise en cache (cf. resolveByIsbn).
        this.logger.warn(
          `bnf: edition unparsable title="${titleFr}" startRecord=${startRecord}`,
        );
        complete = false;
        break;
      }
      if (parsed.numberOfRecords > 0) total = parsed.numberOfRecords;
      all.push(...parsed.records);
      if (cached === null) {
        const ttl = since
          ? SINCE_CACHE_TTL_SECONDS
          : parsed.records.length > 0
            ? EDITION_CACHE_TTL_SECONDS
            : EMPTY_EDITION_PAGE_TTL_SECONDS;
        try {
          await this.cache.set(cacheKey, xml, ttl);
        } catch {
          // La page lue reste exploitable ; on s'arrête là, le résultat est marqué incomplet.
          this.logger.warn(
            `bnf: edition cache write failed title="${titleFr}" startRecord=${startRecord}`,
          );
          complete = false;
          break;
        }
      }

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
      // Même lecture que l'énumération (edition-records) : toutes les 210/214, première à porter un
      // $c — une 214 d'imprimeur sans $c placée en tête ne doit pas vider l'éditeur du scan.
      publisherFr: firstSubfieldAmong(rec, ['210', '214'], 'c'),
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

/** Tome d'édition à partir d'une notice relue (cf. `edition-records`). */
function toTome(r: EditionRecord, volume: number): EditionTome {
  return {
    editionVolume: volume,
    sourceVolumeRange: r.sourceVolumeRange,
    isbn: r.isbn,
    titleFr: r.rawTitle,
    // 330$a — résumé propre au tome (souvent absent) ; repli Google Books côté search.
    description: r.description,
    noticeCreatedAt: r.noticeCreatedAt,
  };
}

/** Valeur insérable entre guillemets dans une requête CQL : un `"` fermerait la phrase. */
function cqlPhrase(s: string): string {
  return s.replace(/["\\]/g, ' ').trim();
}

function quote(s: string | null | undefined): string {
  return s ? `"${s}"` : '-';
}
