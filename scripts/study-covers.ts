/**
 * Étude « fiabilité de l'appariement des jaquettes » (issue jaquettes manga).
 *
 * Depuis un ISBN, le script :
 *   1. interroge la BnF (SRU `bib.fuzzyISBN`) et extrait la notice (mêmes champs que BnfService) ;
 *   2. interroge Google Books en `isbn:<isbn>` et affiche la notice brute (identifiants + image) ;
 *   3. interroge Google Books en `intitle:<série FR>` et DUMPE toutes les notices ILLUSTRÉES
 *      (industryIdentifiers, authors, publisher, seriesInfo, language…) ;
 *   4. évalue chaque clé d'appariement candidate (ISBN, auteur, éditeur, seriesInfo, titre+tome)
 *      pour répondre : « a-t-on plus fiable que le nom normalisé pour retrouver le bon tome ? » ;
 *   5. si AUCUNE jaquette FR n'existe, replie sur le titre original (454$t, ex. japonais) et dumpe.
 *
 * Lecture seule, best-effort, aucun secret affiché. `GOOGLE_BOOKS_API_KEY` recommandé (quota).
 *
 * Usage (dans le conteneur app) :
 *   ./scripts/dev.ps1 study-covers <ISBN> [<ISBN> ...] [--raw]
 *   ex: ./scripts/dev.ps1 study-covers 9791032706343 9782811635923 9791032701881
 *   --raw : ajoute le JSON brut complet de la 1re notice illustrée (pour repérer des champs inédits).
 */
import {
  allDatafields,
  firstSubfield,
  parseUnimarc,
  subfieldOf,
  UnimarcRecord,
} from '../src/common/sources/bnf/unimarc.parser';

const BNF_SRU = process.env.BNF_SRU_BASE_URL ?? 'https://catalogue.bnf.fr/api/SRU';
const GB_BASE = 'https://www.googleapis.com/books/v1/volumes';
const GB_KEY = process.env.GOOGLE_BOOKS_API_KEY;

// ---------------------------------------------------------------------------
// HTTP best-effort avec petit retry sur 429/503 (Google renvoie souvent 503).
// ---------------------------------------------------------------------------
async function httpText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'acervatim-study' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function gbGet(query: string, maxResults = 40): Promise<GbVolume[]> {
  const params = new URLSearchParams({ q: query, country: 'FR', maxResults: String(maxResults) });
  if (GB_KEY) params.set('key', GB_KEY);
  const url = `${GB_BASE}?${params.toString()}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const body = (await res.json()) as { items?: GbVolume[] };
      return body.items ?? [];
    }
    if (res.status !== 429 && res.status !== 503) {
      throw new Error(`GB HTTP ${res.status} for q=${query}`);
    }
    await sleep(300 * attempt);
  }
  console.warn(`  ! GB abandon (429/503) pour q=${query}`);
  return [];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Google Books — types partiels + accès.
// ---------------------------------------------------------------------------
interface GbVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    language?: string;
    printType?: string;
    categories?: string[];
    pageCount?: number;
    canonicalVolumeLink?: string;
    industryIdentifiers?: { type: string; identifier: string }[];
    seriesInfo?: unknown;
    imageLinks?: Record<string, string>;
  };
}

const vi = (v: GbVolume) => v.volumeInfo ?? {};
const hasCover = (v: GbVolume) => Boolean(vi(v).imageLinks);
const isbnsOf = (v: GbVolume) =>
  (vi(v).industryIdentifiers ?? [])
    .filter((i) => i.type.startsWith('ISBN'))
    .map((i) => i.identifier);

interface SeriesRef {
  seriesId: string;
  bookDisplayNumber: string | null;
  bookType: string | null;
}

/** seriesInfo Google Books → { seriesId, bookDisplayNumber, bookType } de la 1re série, ou null. */
function seriesOf(v: GbVolume): SeriesRef | null {
  const si = vi(v).seriesInfo as
    | {
        bookDisplayNumber?: string;
        volumeSeries?: { seriesId?: string; seriesBookType?: string }[];
      }
    | undefined;
  const first = si?.volumeSeries?.[0];
  if (!first?.seriesId) return null;
  return {
    seriesId: first.seriesId,
    bookDisplayNumber: si?.bookDisplayNumber ?? null,
    bookType: first.seriesBookType ?? null,
  };
}

// ---------------------------------------------------------------------------
// BnF — notice normalisée (sous-ensemble des champs de BnfService.extractNotice).
// ---------------------------------------------------------------------------
interface Notice {
  isbn: string;
  titleFr: string | null;
  volume: string | null;
  edition: string | null;
  publisherFr: string | null;
  seriesTitle: string | null;
  originalTitle: string | null;
  authorSurnames: string[];
}

async function bnfNotice(isbn: string): Promise<Notice | null> {
  const norm = isbn.replace(/[^0-9Xx]/g, '');
  const params = new URLSearchParams({
    version: '1.2',
    operation: 'searchRetrieve',
    recordSchema: 'unimarcxchange',
    maximumRecords: '3',
    query: `bib.fuzzyISBN all "${norm}"`,
  });
  let xml: string;
  try {
    xml = await httpText(`${BNF_SRU}?${params.toString()}`);
  } catch (e) {
    console.warn(`  ! BnF indisponible: ${(e as Error).message}`);
    return null;
  }
  const parsed = parseUnimarc(xml);
  if (parsed.records.length === 0) return null;
  const rec = parsed.records[0];
  return {
    isbn: norm,
    titleFr: firstSubfield(rec, '200', 'a') ?? null,
    volume: firstSubfield(rec, '200', 'h') ?? null,
    edition: firstSubfield(rec, '205', 'a') ?? null,
    publisherFr:
      firstSubfield(rec, '210', 'c') ?? firstSubfield(rec, '214', 'c') ?? null,
    seriesTitle:
      firstSubfield(rec, '461', 't') ??
      firstSubfield(rec, '225', 'a') ??
      firstSubfield(rec, '200', 'a') ??
      null,
    originalTitle:
      firstSubfield(rec, '454', 't') ?? firstSubfield(rec, '500', 'a') ?? null,
    authorSurnames: authorSurnames(rec),
  };
}

function authorSurnames(rec: UnimarcRecord): string[] {
  const out: string[] = [];
  for (const df of [...allDatafields(rec, '700'), ...allDatafields(rec, '701')]) {
    const s = subfieldOf(df, 'a');
    if (s) out.push(s);
  }
  const f = firstSubfield(rec, '200', 'f');
  if (out.length === 0 && f) out.push(f);
  return out;
}

// ---------------------------------------------------------------------------
// Normalisation partagée (identique à celle du service : accents/ponctuation).
// ---------------------------------------------------------------------------
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// ---------------------------------------------------------------------------
// Affichage d'une notice GB illustrée.
// ---------------------------------------------------------------------------
function dumpVolume(v: GbVolume, indent = '    '): void {
  const i = vi(v);
  console.log(`${indent}• "${i.title ?? '?'}"${i.subtitle ? ` — ${i.subtitle}` : ''}`);
  console.log(
    `${indent}  id=${v.id} lang=${i.language ?? '?'} printType=${i.printType ?? '?'} publisher=${i.publisher ?? '?'} date=${i.publishedDate ?? '?'}`,
  );
  console.log(`${indent}  authors=${JSON.stringify(i.authors ?? [])}`);
  console.log(`${indent}  isbns=${JSON.stringify(isbnsOf(v))}`);
  console.log(
    `${indent}  seriesInfo=${i.seriesInfo ? JSON.stringify(i.seriesInfo) : '(absent)'} categories=${JSON.stringify(i.categories ?? [])}`,
  );
}

// ---------------------------------------------------------------------------
// Évaluation des clés candidates pour l'ISBN étudié.
// ---------------------------------------------------------------------------
function evaluateKeys(
  notice: Notice,
  coveredFr: GbVolume[],
  anchor: SeriesRef | null,
): void {
  console.log('\n  === Fiabilité des clés d’appariement (notices FR illustrées) ===');
  const bnfVolume = notice.volume ? String(parseInt(notice.volume, 10)) : null;

  // 1. ISBN : une notice illustrée porte-t-elle l'ISBN papier scanné ?
  const byIsbn = coveredFr.find((v) => isbnsOf(v).includes(notice.isbn));
  console.log(
    `  [ISBN papier ${notice.isbn}] ${byIsbn ? `TROUVÉ sur une notice illustrée ("${vi(byIsbn).title}") -> clé FIABLE` : 'ABSENT des notices illustrées -> inutilisable seul'}`,
  );

  // 2. seriesInfo : regroupement par seriesId (une série/édition = un seriesId).
  const bySeries = new Map<string, GbVolume[]>();
  for (const v of coveredFr) {
    const s = seriesOf(v);
    if (!s) continue;
    const list = bySeries.get(s.seriesId) ?? [];
    list.push(v);
    bySeries.set(s.seriesId, list);
  }
  console.log(
    `  [seriesInfo Google] ${coveredFr.filter(seriesOf).length}/${coveredFr.length} notices illustrées portent un seriesId — ${bySeries.size} série(s)/édition(s) distincte(s) :`,
  );
  for (const [sid, vols] of bySeries) {
    const nums = vols
      .map((v) => seriesOf(v)?.bookDisplayNumber)
      .filter(Boolean)
      .sort((a, b) => Number(a) - Number(b));
    const sample = vi(vols[0]).title;
    const type = seriesOf(vols[0])?.bookType;
    console.log(
      `      - seriesId=${sid} type=${type} n=${vols.length} tomes=[${nums.join(',')}] ex="${sample}"${anchor?.seriesId === sid ? '  <<< == ANCRE ISBN' : ''}`,
    );
  }

  // 2b. Clé (ancre seriesId + n° de tome) : la plus forte si l'ancre existe.
  if (anchor && bnfVolume) {
    const hit = coveredFr.find((v) => {
      const s = seriesOf(v);
      return s?.seriesId === anchor.seriesId && s.bookDisplayNumber === bnfVolume;
    });
    console.log(
      `  [ANCRE seriesId+tome] seriesId=${anchor.seriesId} + n°${bnfVolume} -> ${hit ? `MATCH "${vi(hit).title}" — clé la PLUS fiable (édition garantie)` : 'aucune notice illustrée (édition sans jaquette Google)'}`,
    );
  }

  // 2c. Clé (seriesId + n° tome) sans ancre : combien de séries proposent ce n° ? (ambiguïté d'édition)
  if (bnfVolume) {
    const seriesWithVol = [...bySeries.entries()].filter(([, vols]) =>
      vols.some((v) => seriesOf(v)?.bookDisplayNumber === bnfVolume),
    );
    console.log(
      `  [seriesId+tome sans ancre] n°${bnfVolume} présent dans ${seriesWithVol.length} série(s) -> ${seriesWithVol.length > 1 ? 'AMBIGU (plusieurs éditions), il faut discriminer l’édition' : seriesWithVol.length === 1 ? 'unique ici' : 'absent'}`,
    );
  }

  // 3. Auteur : les notices illustrées partagent-elles l'auteur BnF ?
  const wantAuthors = notice.authorSurnames.map(norm).filter(Boolean);
  const authorHits = coveredFr.filter((v) => {
    const a = (vi(v).authors ?? []).map(norm);
    return wantAuthors.some((w) => a.some((x) => x.includes(w) || w.includes(x)));
  }).length;
  console.log(
    `  [Auteur ${JSON.stringify(notice.authorSurnames)}] ${authorHits}/${coveredFr.length} notices illustrées concordent`,
  );

  // 4. Éditeur : idem.
  const wantPub = notice.publisherFr ? norm(notice.publisherFr) : '';
  const pubHits = wantPub
    ? coveredFr.filter((v) => {
        const p = norm(vi(v).publisher ?? '');
        return p && (p.includes(wantPub) || wantPub.includes(p));
      }).length
    : 0;
  console.log(
    `  [Éditeur ${notice.publisherFr ?? '-'}] ${pubHits}/${coveredFr.length} notices illustrées concordent`,
  );

  // 5. Titre normalisé (approche actuelle) : combien commencent par la série ?
  const wantSeries = norm(notice.seriesTitle ?? '');
  const titleHits = coveredFr.filter((v) => norm(vi(v).title ?? '').startsWith(wantSeries)).length;
  console.log(
    `  [Titre normalisé "${wantSeries}"] ${titleHits}/${coveredFr.length} notices illustrées commencent par la série (référence actuelle)`,
  );
}

// ---------------------------------------------------------------------------
// Étude d'un ISBN.
// ---------------------------------------------------------------------------
async function study(isbn: string, raw: boolean): Promise<void> {
  console.log(`\n${'='.repeat(78)}\nISBN ${isbn}\n${'='.repeat(78)}`);

  const notice = await bnfNotice(isbn);
  if (!notice) {
    console.log('  BnF: notice introuvable — étude interrompue.');
    return;
  }
  console.log('  --- Notice BnF ---');
  console.log(`  titleFr="${notice.titleFr}" vol=${notice.volume ?? '-'} edition="${notice.edition ?? 'standard'}"`);
  console.log(`  seriesTitle="${notice.seriesTitle}" originalTitle="${notice.originalTitle ?? '-'}"`);
  console.log(`  publisherFr="${notice.publisherFr}" authors=${JSON.stringify(notice.authorSurnames)}`);

  // Étape 2 : GB par ISBN exact — anchor éventuel via seriesInfo.
  console.log('\n  --- Google Books : q=isbn:<isbn> (ancre d’édition ?) ---');
  const byIsbn = await gbGet(`isbn:${notice.isbn}`, 5);
  let anchor: SeriesRef | null = null;
  if (byIsbn.length === 0) {
    console.log('    (aucune notice)');
  } else {
    for (const v of byIsbn) {
      const s = seriesOf(v);
      if (s && !anchor) anchor = s;
      console.log(
        `    "${vi(v).title}" cover=${hasCover(v) ? 'OUI' : 'non'} isbns=${JSON.stringify(isbnsOf(v))} seriesInfo=${s ? `seriesId=${s.seriesId} n°=${s.bookDisplayNumber} type=${s.bookType}` : '(absent)'}`,
      );
    }
  }
  console.log(
    anchor
      ? `    -> ANCRE seriesId=${anchor.seriesId} depuis l'ISBN scanné : clé d'édition FIABLE si les notices illustrées la partagent.`
      : `    -> Pas de seriesInfo sur l'ISBN scanné : impossible d'ancrer l'édition par cette voie.`,
  );

  // Étape 3 : GB par titre de série FR, notices illustrées.
  const seriesTitle = notice.seriesTitle ?? notice.titleFr ?? '';
  console.log(`\n  --- Google Books : q=intitle:"${seriesTitle}" (notices ILLUSTRÉES) ---`);
  const fr = await gbGet(`intitle:${seriesTitle}`, 40);
  const coveredFr = fr.filter(hasCover);
  console.log(`    ${coveredFr.length}/${fr.length} notices illustrées`);
  for (const v of coveredFr.slice(0, 12)) dumpVolume(v);
  if (raw && coveredFr[0]) {
    console.log('\n    --- JSON brut (1re notice illustrée) ---');
    console.log(JSON.stringify(coveredFr[0], null, 2).replace(/^/gm, '    '));
  }

  evaluateKeys(notice, coveredFr, anchor);

  // Étape 5 : repli titre original si aucune jaquette FR.
  const anyFrCover = coveredFr.some((v) => (vi(v).language ?? 'fr') === 'fr');
  if (!anyFrCover && notice.originalTitle) {
    console.log(`\n  --- REPLI titre original : q=intitle:"${notice.originalTitle}" ---`);
    const orig = await gbGet(`intitle:${notice.originalTitle}`, 40);
    const coveredOrig = orig.filter(hasCover);
    console.log(`    ${coveredOrig.length}/${orig.length} notices illustrées (édition originale)`);
    for (const v of coveredOrig.slice(0, 12)) dumpVolume(v);
  } else if (!anyFrCover) {
    console.log('\n  --- REPLI titre original impossible (454$t absent) ---');
  } else {
    console.log('\n  (jaquettes FR disponibles — pas de repli original nécessaire)');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const raw = args.includes('--raw');
  const isbns = args.filter((a) => !a.startsWith('--'));
  if (isbns.length === 0) {
    console.log('usage: ./scripts/dev.ps1 study-covers <ISBN> [<ISBN> ...] [--raw]');
    process.exitCode = 1;
    return;
  }
  if (!GB_KEY) console.warn('! GOOGLE_BOOKS_API_KEY absent — quota anonyme, résultats possiblement tronqués (429).\n');
  for (const isbn of isbns) {
    await study(isbn, raw);
    await sleep(400);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
