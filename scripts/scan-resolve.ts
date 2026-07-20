/**
 * Résout un lot d'ISBN comme le ferait un scan manga, EN RÉUTILISANT le code backend
 * (pivot BnF→MAL, énumération d'édition, jaquettes/résumés Google Books) et sa gestion
 * de quota : tous les appels sortants passent par les files BullMQ throttlées globalement
 * (bnf / mal / gbooks). Tous les ISBN sont lancés EN PARALLÈLE, chacun sous un utilisateur
 * premium distinct, pour simuler N utilisateurs simultanés et observer le comportement sous
 * dépassement de quota (les limiters de file sérialisent le débit sortant, best-effort).
 *
 * Le script boote un contexte applicatif Nest (createApplicationContext) : il instancie donc
 * AUSSI les workers BullMQ in-process. Il est donc autonome (Redis + DB up suffisent) ; si l'app
 * tourne déjà, les deux jeux de workers se partagent les files sans souci (throttle Redis global).
 *
 * Pour chaque ISBN il rapporte :
 *  - si la collection a été trouvée et par quel chemin (bnf+mal / bnf+mal-fr / bnf_only / not_found) ;
 *  - la série (titre, édition) + le résumé de série et SA source (bnf 330$a, ou mal synopsis) ;
 *  - tous les tomes de l'édition (y compris le tome scanné), et pour chacun :
 *      · la jaquette + sa source (google_books) + son statut (found/absent/unresolved),
 *      · un résumé + sa source (bnf 330$a prioritaire, sinon google_books).
 *
 * Sortie : un JSON récapitulatif (voir --out).
 *
 * Refuse NODE_ENV=production (crée des utilisateurs de test premium).
 *
 * Usage (dans le conteneur app, app + Redis + DB up) :
 *   ./scripts/dev.ps1 scan-resolve [<fichier.txt>] [--out <result.json>] [--tome-concurrency N]
 *   défaut fichier : test/fixtures/scanned-isbns.txt
 *   défaut sortie  : <fichier sans .txt>.result.json
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHmac, randomUUID } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { AppModule } from '../src/app.module';
import { BnfService } from '../src/common/sources/bnf/bnf.service';
import { BnfNotice } from '../src/common/sources/bnf/bnf.types';
import { GoogleBooksCoverService } from '../src/common/sources/googlebooks/googlebooks.service';
import { CoverStatus } from '../src/common/sources/googlebooks/googlebooks.types';
import { isSpecialArtEdition } from '../src/common/sources/manga-matching';
import { MangaDexCoverService } from '../src/common/sources/mangadex/mangadex.service';
import {
  MangaDexIdentity,
  MangaDexSeriesCovers,
} from '../src/common/sources/mangadex/mangadex.types';
import { MalAdapter } from '../src/oauth/providers/mal.adapter';
import { UnifiedItem } from '../src/oauth/providers/types';
import { PrismaService } from '../src/prisma/prisma.service';

const DEFAULT_INPUT = 'test/fixtures/scanned-isbns.txt';
const DEFAULT_TOME_CONCURRENCY = 4;
// Concurrence au niveau ISBN : bornée (≠ « tous en parallèle ») pour ne pas saturer les files
// (BnF max 10 req/s, Google Books 4 req/s) au point de dépasser les timeouts d'attente côté client
// (20 s BnF, 15 s Google) — ce qui produisait des `not_found` / énumérations tronquées transitoires.
const DEFAULT_ISBN_CONCURRENCY = 3;
// BnF : les échecs sous charge (`bnf_unavailable`) sont TRANSITOIRES et non cachés — on retente ;
// `bnf_not_found` est terminal (vraie absence catalogue), pas de retry.
const DEFAULT_BNF_ATTEMPTS = 6;
// Settle : les jaquettes `unresolved` (503 Google en vagues) sont re-poussées jusqu'à convergence,
// dans la LIMITE de ce budget de temps (le worker gbooks est sérialisé + rate-limité).
const DEFAULT_SETTLE_MS = 240_000;

const log = new Logger('scan-resolve');

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// Types de sortie.
// --------------------------------------------------------------------------
type SummarySource = 'bnf' | 'google_books' | 'mal' | 'mangadex' | null;
type ScanResolution =
  | 'bnf+mangadex'
  | 'bnf+mangadex-fr'
  | 'bnf+mal'
  | 'bnf+mal-fr'
  | 'bnf_only'
  | 'not_found';
/** Voie d'identification retenue (source de l'item) — pour les compteurs du plan §4. */
type IdentificationSource = 'mangadex' | 'mal' | 'bnf' | null;

interface TomeResult {
  editionVolume: number | null;
  isbn: string | null;
  titleFr: string | null;
  isScanned: boolean;
  cover: {
    found: boolean;
    url: string | null;
    status: CoverStatus;
    source: 'mangadex' | 'google_books' | null;
  };
  summary: {
    found: boolean;
    source: SummarySource; // 'bnf' (330$a) prioritaire, sinon 'google_books'
    text: string | null;
  };
}

interface IsbnResult {
  isbn: string;
  scanResolution: ScanResolution;
  /** Voie d'identification retenue (mangadex / repli mal / bnf_only). */
  identificationSource: IdentificationSource;
  collectionFound: boolean;
  malMatched: boolean;
  /** Langue du synopsis de série retenu (fr attendu majoritaire via MangaDex). */
  synopsisLang: 'fr' | 'en' | null;
  confidence: number | null;
  series: {
    titleFr: string | null;
    edition: string | null; // null = édition standard
    malId: string | null;
    malTitle: string | null;
    malNumVolumes: number | null;
    summary: { text: string | null; source: SummarySource };
  } | null;
  enumeration: {
    tomeCount: number;
    recordsScanned: number;
    ongoing: boolean;
    scannedTomeFound: boolean;
  } | null;
  tomes: TomeResult[];
  elapsedMs: number;
  error?: string;
}

// --------------------------------------------------------------------------
// Helpers.
// --------------------------------------------------------------------------

/** ISBN → forme comparable (chiffres + X). */
function normIsbn(s: string | null | undefined): string {
  return (s ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

/** Lit le fichier fixture : une ISBN par ligne, commentaires `#` et code après `#` ignorés. */
function readIsbns(path: string): string[] {
  const raw = readFileSync(path, 'utf8');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const code = trimmed.split(/\s+/)[0]; // « 9782... # commentaire » -> « 9782... »
    const norm = normIsbn(code);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/** Applique `fn` avec au plus `limit` exécutions concurrentes (ordre préservé). */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}

function parseArgs(argv: string[]): {
  input: string;
  out: string;
  tomeConcurrency: number;
  isbnConcurrency: number;
  bnfAttempts: number;
  settleMs: number;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      flags[tok.slice(2)] = argv[++i] ?? '';
    } else {
      positional.push(tok);
    }
  }
  const input = positional[0] ?? DEFAULT_INPUT;
  const out = flags.out ?? input.replace(/\.txt$/, '') + '.result.json';
  const num = (k: string, d: number) =>
    flags[k] ? Math.max(0, Number(flags[k])) : d;
  return {
    input,
    out,
    tomeConcurrency: Math.max(
      1,
      num('tome-concurrency', DEFAULT_TOME_CONCURRENCY),
    ),
    isbnConcurrency: Math.max(1, num('concurrency', DEFAULT_ISBN_CONCURRENCY)),
    bnfAttempts: Math.max(1, num('bnf-attempts', DEFAULT_BNF_ATTEMPTS)),
    settleMs: num('settle-ms', DEFAULT_SETTLE_MS),
  };
}

/**
 * `resolveByIsbn` avec retry sur échec TRANSITOIRE (bnf_unavailable / rate_limited / unparsable),
 * backoff exponentiel plafonné. `bnf_not_found` (vraie absence) et le succès sont terminaux.
 */
async function resolveByIsbnRobust(
  bnf: BnfService,
  isbn: string,
  attempts: number,
): Promise<Awaited<ReturnType<BnfService['resolveByIsbn']>>> {
  let last: Awaited<ReturnType<BnfService['resolveByIsbn']>> = {
    ok: false,
    reason: 'bnf_unavailable',
  };
  for (let i = 0; i < attempts; i++) {
    const res = await bnf.resolveByIsbn(isbn);
    if (res.ok || res.reason === 'bnf_not_found') return res;
    last = res;
    if (i < attempts - 1) await sleep(500 * Math.min(16, 2 ** i));
  }
  return last;
}

/**
 * `enumerateEdition` avec retry : sous charge une page SRU peut échouer et tronquer l'énumération.
 * Les pages OK étant cachées, une nouvelle tentative ne re-fetch que la page manquante. On conserve
 * le mapping au plus grand nombre de tomes et on s'arrête dès que le compte se stabilise (>0).
 */
async function enumerateEditionRobust(
  bnf: BnfService,
  titleFr: string,
  edition: string | null,
  attempts: number,
): Promise<Awaited<ReturnType<BnfService['enumerateEdition']>> | null> {
  let best: Awaited<ReturnType<BnfService['enumerateEdition']>> | null = null;
  let prev = -1;
  for (let i = 0; i < attempts; i++) {
    let m: Awaited<ReturnType<BnfService['enumerateEdition']>> | null = null;
    try {
      m = await bnf.enumerateEdition(titleFr, edition);
    } catch {
      m = null;
    }
    if (m && (!best || m.tomeCount > best.tomeCount)) best = m;
    const count = best?.tomeCount ?? 0;
    if (count > 0 && count === prev) break; // stabilisé
    prev = count;
    if (i < attempts - 1) await sleep(500 * Math.min(8, i + 1));
  }
  return best;
}

// --------------------------------------------------------------------------
// Utilisateurs premium simulés (pour que le pivot MAL prenne le repli
// X-MAL-CLIENT-ID au lieu du mode dégradé cache-only).
// --------------------------------------------------------------------------
async function ensurePremiumUsers(
  prisma: PrismaService,
  count: number,
): Promise<string[]> {
  const pepper = process.env.SUB_HASH_PEPPER;
  if (!pepper) throw new Error('SUB_HASH_PEPPER must be set in .env');
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const subHash = createHmac('sha256', pepper)
      .update(`scan-resolve-sim-${i}`)
      .digest('hex');
    const user = await prisma.user.upsert({
      where: { googleSubHash: subHash },
      update: {},
      create: { id: randomUUID(), googleSubHash: subHash },
    });
    await prisma.premiumGrant.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        reason: 'comp',
        grantedBy: 'cli',
        expiresAt: null,
        notes: 'scan-resolve simulation',
      },
      update: {},
    });
    ids.push(user.id);
  }
  return ids;
}

// --------------------------------------------------------------------------
// Résolution d'un ISBN (pivot + énumération + jaquettes/résumés).
// --------------------------------------------------------------------------
async function resolveOne(
  isbn: string,
  userId: string,
  deps: {
    mal: MalAdapter;
    bnf: BnfService;
    gbooks: GoogleBooksCoverService;
    mangadex: MangaDexCoverService;
    tomeConcurrency: number;
    bnfAttempts: number;
  },
): Promise<IsbnResult> {
  const startedAt = Date.now();
  const base: IsbnResult = {
    isbn,
    scanResolution: 'not_found',
    identificationSource: null,
    collectionFound: false,
    malMatched: false,
    synopsisLang: null,
    confidence: null,
    series: null,
    enumeration: null,
    tomes: [],
    elapsedMs: 0,
  };

  try {
    // 1) Notice BnF (série, édition, note 330$a) — retry des échecs transitoires (non cachés).
    const resolution = await resolveByIsbnRobust(
      deps.bnf,
      isbn,
      deps.bnfAttempts,
    );
    if (!resolution.ok) {
      // `bnf_not_found` = vraie absence ; tout autre motif = indispo persistante après retries
      // (à distinguer d'un vrai « pas dans le catalogue »).
      return {
        ...base,
        elapsedMs: Date.now() - startedAt,
        error:
          resolution.reason === 'bnf_not_found'
            ? undefined
            : `bnf indisponible après ${deps.bnfAttempts} tentatives (${resolution.reason})`,
      };
    }
    const notice: BnfNotice = resolution.notice;

    // 2) Pivot BnF→MangaDex→MAL (via searchByBarcode, exactement comme un scan).
    const pivotRes = await deps.mal.searchByBarcode(isbn, {
      userId,
      limit: 10,
    });
    const item: UnifiedItem | undefined = pivotRes.items[0];
    const pivotMeta = (item?.metadata?.pivot ?? {}) as {
      resolutionPath?: ScanResolution;
      confidence?: number;
      malId?: string | null;
    };
    const scanResolution: ScanResolution =
      pivotMeta.resolutionPath ?? (item ? 'bnf_only' : 'not_found');
    const viaMangaDex =
      scanResolution === 'bnf+mangadex' || scanResolution === 'bnf+mangadex-fr';
    const viaMal =
      scanResolution === 'bnf+mal' || scanResolution === 'bnf+mal-fr';
    const identificationSource: IdentificationSource = viaMangaDex
      ? 'mangadex'
      : viaMal
        ? 'mal'
        : item
          ? 'bnf'
          : null;
    // mal_id : porté par links.mal en chemin MangaDex, ou sourceId en repli MAL.
    const malId = viaMangaDex
      ? (pivotMeta.malId ?? null)
      : item?.source === 'mal'
        ? item.sourceId
        : null;
    const malMatched = !!malId;

    // Résumé de série + source : synopsis MangaDex FR prioritaire (chemin nominal), sinon 330$a BnF,
    // sinon synopsis MAL (en). On lit l'identité MangaDex (rawData) pour connaître la langue exacte.
    const mdIdentity =
      viaMangaDex && item ? (item.rawData as MangaDexIdentity) : null;
    let seriesSummarySource: SummarySource;
    let synopsisLang: 'fr' | 'en' | null;
    if (mdIdentity?.descriptionFr) {
      seriesSummarySource = 'mangadex';
      synopsisLang = 'fr';
    } else if (notice.noteFr) {
      seriesSummarySource = 'bnf';
      synopsisLang = 'fr';
    } else if (mdIdentity?.descriptionEn) {
      seriesSummarySource = 'mangadex';
      synopsisLang = 'en';
    } else if (viaMal && item?.description) {
      seriesSummarySource = 'mal';
      synopsisLang = 'en';
    } else {
      seriesSummarySource = null;
      synopsisLang = null;
    }

    const series = {
      titleFr: notice.seriesTitle ?? notice.titleFr ?? null,
      edition: notice.edition ?? null,
      malId,
      malTitle: item?.title ?? null,
      malNumVolumes:
        (item?.metadata?.num_volumes as number | undefined) ?? null,
      summary: {
        text: item?.description ?? notice.noteFr ?? null,
        source: seriesSummarySource,
      },
    };

    // 3) Énumération de l'édition (tous les tomes) via BnF.
    const seriesTitle = notice.seriesTitle ?? notice.titleFr;
    let tomes: TomeResult[] = [];
    let enumeration: IsbnResult['enumeration'] = null;
    const mapping = seriesTitle
      ? await enumerateEditionRobust(
          deps.bnf,
          seriesTitle,
          notice.edition ?? null,
          deps.bnfAttempts,
        )
      : null;
    // MangaDex par SÉRIE (un seul appel) : jaquettes par n° de tome, join fiable via mal_id.
    // Garde-fou éditions d'art (plan §3) : on saute MangaDex (visuel/numérotation distincts) et on
    // laisse la cascade Google Books édition-consciente — les retirages (ordinaux) restent standard.
    const useMangaDex = !!seriesTitle && !isSpecialArtEdition(notice.edition);
    const mdCovers: MangaDexSeriesCovers | null =
      useMangaDex && seriesTitle
        ? await deps.mangadex.resolveSeriesCovers(malId, seriesTitle)
        : null;
    if (mapping) {
      // 4) Par tome : cascade MangaDex (série+tome) -> Google Books (ISBN).
      tomes = await mapWithConcurrency(
        mapping.tomes,
        deps.tomeConcurrency,
        async (tome): Promise<TomeResult> => {
          const isScanned = !!tome.isbn && normIsbn(tome.isbn) === isbn;
          const mdCover = mdCovers?.volumes[String(tome.editionVolume)];

          if (mdCover) {
            // MangaDex a la jaquette du tome : on ne tape pas Google (économie de quota).
            const summaryText = tome.description ?? null;
            return {
              editionVolume: tome.editionVolume,
              isbn: tome.isbn,
              titleFr: tome.titleFr,
              isScanned,
              cover: {
                found: true,
                url: mdCover.url,
                status: 'found',
                source: 'mangadex',
              },
              summary: {
                found: summaryText !== null,
                source: summaryText ? 'bnf' : null,
                text: summaryText,
              },
            };
          }

          // Repli Google Books par ISBN (jaquette + résumé).
          const resolved = tome.isbn
            ? await deps.gbooks.resolveCoverAndDescription(tome.isbn, {
                title: mapping.titleFr,
                volume: tome.editionVolume,
                edition: mapping.edition,
              })
            : { coverUrl: null, description: null, status: 'absent' as const };

          const bnfDesc = tome.description; // 330$a du tome
          const gbDesc = resolved.description;
          const summaryText = bnfDesc ?? gbDesc ?? null;
          const summarySource: SummarySource = bnfDesc
            ? 'bnf'
            : gbDesc
              ? 'google_books'
              : null;

          return {
            editionVolume: tome.editionVolume,
            isbn: tome.isbn,
            titleFr: tome.titleFr,
            isScanned,
            cover: {
              found: resolved.status === 'found',
              url: resolved.coverUrl,
              status: resolved.status,
              source: resolved.status === 'found' ? 'google_books' : null,
            },
            summary: {
              found: summaryText !== null,
              source: summarySource,
              text: summaryText,
            },
          };
        },
      );

      enumeration = {
        tomeCount: mapping.tomeCount,
        recordsScanned: mapping.recordsScanned,
        ongoing: mapping.ongoing,
        scannedTomeFound: tomes.some((t) => t.isScanned),
      };
    }

    // 4bis) Le tome scanné doit figurer même si l'énumération d'édition ne l'a pas
    // ramené (ex. mention d'édition divergente) : cascade MangaDex -> Google Books par ISBN.
    if (!tomes.some((t) => t.isScanned)) {
      const scanVol = notice.volume ? Number(notice.volume) : null;
      const mdScan =
        scanVol != null ? mdCovers?.volumes[String(scanVol)] : undefined;
      if (mdScan) {
        const summaryText = notice.noteFr ?? null;
        tomes.push({
          editionVolume: scanVol,
          isbn,
          titleFr: notice.titleFr,
          isScanned: true,
          cover: {
            found: true,
            url: mdScan.url,
            status: 'found',
            source: 'mangadex',
          },
          summary: {
            found: summaryText !== null,
            source: summaryText ? 'bnf' : null,
            text: summaryText,
          },
        });
      } else {
        const resolved = await deps.gbooks.resolveCoverAndDescription(isbn, {
          title: notice.seriesTitle ?? notice.titleFr ?? '',
          volume: scanVol ?? 0,
          edition: notice.edition ?? null,
        });
        const bnfDesc = notice.noteFr;
        const gbDesc = resolved.description;
        const summaryText = bnfDesc ?? gbDesc ?? null;
        tomes.push({
          editionVolume: scanVol,
          isbn,
          titleFr: notice.titleFr,
          isScanned: true,
          cover: {
            found: resolved.status === 'found',
            url: resolved.coverUrl,
            status: resolved.status,
            source: resolved.status === 'found' ? 'google_books' : null,
          },
          summary: {
            found: summaryText !== null,
            source: bnfDesc ? 'bnf' : gbDesc ? 'google_books' : null,
            text: summaryText,
          },
        });
      }
      if (enumeration) enumeration.scannedTomeFound = true;
    }

    return {
      ...base,
      scanResolution,
      identificationSource,
      collectionFound: scanResolution !== 'not_found',
      malMatched,
      synopsisLang,
      confidence: pivotMeta.confidence ?? null,
      series,
      enumeration,
      tomes,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/**
 * Re-pousse les jaquettes encore `unresolved` (transitoire : 503 Google en vagues) par passes
 * successives jusqu'à ce qu'il n'en reste plus, ou que `settleMs` soit écoulé. Le worker gbooks est
 * sérialisé + rate-limité (4 req/s) : chaque passe fait avancer le cache. Mute `results` en place.
 */
async function settleCovers(
  results: IsbnResult[],
  gbooks: GoogleBooksCoverService,
  settleMs: number,
  concurrency: number,
): Promise<void> {
  const started = Date.now();
  const pending = () => {
    const out: { r: IsbnResult; t: TomeResult }[] = [];
    for (const r of results)
      for (const t of r.tomes)
        if (t.isbn && t.cover.status === 'unresolved') out.push({ r, t });
    return out;
  };
  let pass = 0;
  while (Date.now() - started < settleMs) {
    const batch = pending();
    if (batch.length === 0) break;
    pass++;
    log.log(
      `settle passe ${pass} : ${batch.length} jaquette(s) non résolue(s) — nouvelle tentative`,
    );
    await mapWithConcurrency(batch, concurrency, async ({ r, t }) => {
      if (!t.isbn) return;
      const resolved = await gbooks.resolveCoverAndDescription(t.isbn, {
        title: r.series?.titleFr ?? '',
        volume: t.editionVolume ?? 0,
        edition: r.series?.edition ?? null,
      });
      if (resolved.status === 'unresolved') return; // toujours en vague, on retentera
      t.cover = {
        found: resolved.status === 'found',
        url: resolved.coverUrl,
        status: resolved.status,
        source: resolved.status === 'found' ? 'google_books' : null,
      };
      if (!t.summary.found && resolved.description) {
        t.summary = {
          found: true,
          source: 'google_books',
          text: resolved.description,
        };
      }
    });
    if (pending().length > 0) await sleep(3000);
  }
  const left = pending().length;
  if (left > 0) {
    log.warn(
      `settle : ${left} jaquette(s) encore non résolue(s) après ${Math.round((Date.now() - started) / 1000)}s (quota Google) — statut 'unresolved' conservé`,
    );
  }
}

// --------------------------------------------------------------------------
// Main.
// --------------------------------------------------------------------------
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('scan-resolve is disabled when NODE_ENV=production');
  }
  const {
    input,
    out,
    tomeConcurrency,
    isbnConcurrency,
    bnfAttempts,
    settleMs,
  } = parseArgs(process.argv.slice(2));
  const isbns = readIsbns(input);
  if (isbns.length === 0) {
    throw new Error(`no ISBN found in ${input}`);
  }
  log.log(
    `résolution de ${isbns.length} ISBN depuis ${input} ` +
      `(concurrence=${isbnConcurrency}, retry BnF=${bnfAttempts}, settle covers≤${Math.round(settleMs / 1000)}s, users premium simulés)`,
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();

  try {
    const prisma = app.get(PrismaService, { strict: false });
    const mal = app.get(MalAdapter, { strict: false });
    const bnf = app.get(BnfService, { strict: false });
    const gbooks = app.get(GoogleBooksCoverService, { strict: false });
    const mangadex = app.get(MangaDexCoverService, { strict: false });

    const userIds = await ensurePremiumUsers(prisma, isbns.length);

    const startedAt = Date.now();
    // Concurrence ISBN BORNÉE (simule plusieurs users simultanés sans saturer les files au point de
    // faire expirer les attentes). Les échecs transitoires sont absorbés par les retries (BnF) et la
    // phase de settle (covers) — pas besoin d'un 2ᵉ passage pour obtenir des données complètes.
    let done = 0;
    const items = isbns.map((isbn, i) => ({ isbn, userId: userIds[i] }));
    const results = await mapWithConcurrency(
      items,
      isbnConcurrency,
      async ({ isbn, userId }) => {
        const r = await resolveOne(isbn, userId, {
          mal,
          bnf,
          gbooks,
          mangadex,
          tomeConcurrency,
          bnfAttempts,
        });
        log.log(
          `[${++done}/${isbns.length}] ${isbn} -> ${r.scanResolution} ` +
            `tomes=${r.tomes.length} covers=${r.tomes.filter((t) => t.cover.found).length}` +
            `${r.error ? ' ERR=' + r.error : ''} (${r.elapsedMs} ms)`,
        );
        return r;
      },
    );

    // Phase de settle : re-pousse les jaquettes encore `unresolved` (503 Google en vagues) jusqu'à
    // convergence, dans la limite de `settleMs`. Mute `results` en place.
    await settleCovers(results, gbooks, settleMs, tomeConcurrency);

    const totalMs = Date.now() - startedAt;

    const report = {
      generatedAt: new Date().toISOString(),
      input,
      totalMs,
      count: results.length,
      summary: {
        collectionFound: results.filter((r) => r.collectionFound).length,
        malMatched: results.filter((r) => r.malMatched).length,
        // Voie d'identification (plan §4) : cible = la plupart des mangas via MangaDex.
        idMangadex: results.filter((r) => r.identificationSource === 'mangadex')
          .length,
        idMal: results.filter((r) => r.identificationSource === 'mal').length,
        idBnfOnly: results.filter((r) => r.identificationSource === 'bnf')
          .length,
        // Langue du synopsis de série (fr attendu majoritaire via MangaDex).
        synopsisFr: results.filter((r) => r.synopsisLang === 'fr').length,
        synopsisEn: results.filter((r) => r.synopsisLang === 'en').length,
        bnfOnly: results.filter((r) => r.scanResolution === 'bnf_only').length,
        notFound: results.filter((r) => r.scanResolution === 'not_found')
          .length,
        bnfUnavailable: results.filter(
          (r) => r.error && r.error.startsWith('bnf indisponible'),
        ).length,
        tomesTotal: results.reduce((n, r) => n + r.tomes.length, 0),
        coversFound: results.reduce(
          (n, r) => n + r.tomes.filter((t) => t.cover.found).length,
          0,
        ),
        coversMangadex: results.reduce(
          (n, r) =>
            n + r.tomes.filter((t) => t.cover.source === 'mangadex').length,
          0,
        ),
        coversGoogle: results.reduce(
          (n, r) =>
            n + r.tomes.filter((t) => t.cover.source === 'google_books').length,
          0,
        ),
        coversUnresolved: results.reduce(
          (n, r) =>
            n + r.tomes.filter((t) => t.cover.status === 'unresolved').length,
          0,
        ),
      },
      isbns: results,
    };

    writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
    log.log(
      `terminé en ${totalMs} ms — collection: ${report.summary.collectionFound}/${report.count}, ` +
        `identif [mangadex: ${report.summary.idMangadex}, mal: ${report.summary.idMal}, ` +
        `bnf_only: ${report.summary.idBnfOnly}], synopsis [fr: ${report.summary.synopsisFr}, ` +
        `en: ${report.summary.synopsisEn}], mal_id: ${report.summary.malMatched}, ` +
        `bnf indispo: ${report.summary.bnfUnavailable}, ` +
        `tomes: ${report.summary.tomesTotal}, jaquettes: ${report.summary.coversFound} ` +
        `(mangadex: ${report.summary.coversMangadex}, google: ${report.summary.coversGoogle}, ` +
        `non résolues: ${report.summary.coversUnresolved}) — écrit dans ${out}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
