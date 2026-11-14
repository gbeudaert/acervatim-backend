import {
  artEditionKeywords,
  isSpecialArtEdition,
  matchesAuthor,
} from '../manga-matching';
import { BnfAuthor, EditionSummary } from './bnf.types';
import {
  allDatafields,
  firstSubfield,
  subfieldOf,
  UnimarcRecord,
} from './unimarc.parser';

/**
 * Lecture **pure** des notices BnF pour l'énumération d'une édition et la liste des éditions d'une
 * série. Partagée par `BnfService.enumerateEdition` et `BnfService.listEditions` : les deux doivent
 * reconnaître exactement les mêmes notices comme membres d'une même édition, sinon une édition
 * listée ne se rejouerait pas à l'identique dans `edition-mapping`.
 *
 * Deux constats de l'étude du 2026-10-27 (§ 3) fondent ce module :
 *  - une édition s'identifie par le couple **(éditeur, 205$a)** : la « standard » de *L'attaque des
 *    titans* réunit Pika et les 2-en-1 France Loisirs, qui n'ont ni l'un ni l'autre de 205 ;
 *  - les tomes récents arrivent en **pré-notice** (ni 461, ni 205, auteur en 702, 225$a = collection
 *    de l'éditeur) : l'appartenance ne peut plus être « le premier champ non vide de la chaîne ».
 */

/** Notice relue pour l'énumération : clés normalisées + valeurs brutes utiles à la réponse. */
export interface EditionRecord {
  /** 500$a normalisé — titre uniforme, présent dès la pré-notice (souvent le titre original). */
  uniformKey: string;
  /** 461$t normalisé — ensemble « fait partie de ». */
  setKey: string;
  /** 200$a normalisé — titre propre (titre du tome chez Ki-oon). */
  titleKey: string;
  /** 225$a normalisé — collection ; chez Glénat, « Shonen manga » et non la série. */
  collectionKey: string;
  /** 454$t normalisé — titre original, quand catalogué. */
  originalKey: string;
  rawSetTitle: string | null;
  rawTitle: string | null;
  rawCollection: string | null;
  /** 210$c | 214$c — premier sous-champ $c trouvé, brut. */
  publisher: string | null;
  publisherKey: string;
  /** 205$a brut, null = aucune mention. */
  edition: string | null;
  editionKey: string;
  /**
   * Titre propre normalisé (200$a + 200$e), **seulement** sans 205 (sinon vide) : matière de
   * {@link inferredArtKeywords}, qui en retire d'abord les mots du titre de série.
   */
  titleText: string;
  isbn: string | null;
  sourceVolumeRange: string | null;
  description: string | null;
  /** 210$d | 214$d brut. */
  date: string | null;
  noticeCreatedAt: string | null;
  authors: BnfAuthor[];
  /** Sous-champs bruts de numérotation, interprétés par {@link volumeOf} selon la clé retenue. */
  setVolume: string | null;
  collectionVolume: string | null;
  titleVolume: string | null;
}

export function readEditionRecord(rec: UnimarcRecord): EditionRecord {
  const edition = firstSubfield(rec, '205', 'a') ?? null;
  const rawTitle = firstSubfield(rec, '200', 'a') ?? null;
  const rawSetTitle = firstSubfield(rec, '461', 't') ?? null;
  const rawCollection = firstSubfield(rec, '225', 'a') ?? null;
  const publisher = firstSubfieldAmong(rec, ['210', '214'], 'c');
  const titleText = [rawTitle, firstSubfield(rec, '200', 'e')]
    .filter(Boolean)
    .join(' ');
  return {
    uniformKey: normalizeSeriesKey(firstSubfield(rec, '500', 'a') ?? null),
    setKey: normalizeSeriesKey(rawSetTitle),
    titleKey: normalizeSeriesKey(rawTitle),
    collectionKey: normalizeSeriesKey(rawCollection),
    originalKey: normalizeSeriesKey(firstSubfield(rec, '454', 't') ?? null),
    rawSetTitle,
    rawTitle,
    rawCollection,
    publisher,
    publisherKey: normalizePublisher(publisher),
    edition,
    editionKey: normalizeEdition(edition),
    titleText: edition ? '' : normalizeSeriesKey(titleText),
    isbn: firstSubfield(rec, '010', 'a') ?? null,
    sourceVolumeRange: normalizeVolumeRange(firstSubfield(rec, '454', 'h')),
    description: firstSubfield(rec, '330', 'a') ?? null,
    date: firstSubfieldAmong(rec, ['210', '214'], 'd'),
    noticeCreatedAt: noticeCreationDate(firstSubfield(rec, '100', 'a')),
    authors: extractAuthors(rec),
    setVolume: firstSubfield(rec, '461', 'v') ?? null,
    collectionVolume: firstSubfield(rec, '225', 'v') ?? null,
    titleVolume: firstSubfield(rec, '200', 'h') ?? null,
  };
}

/**
 * La notice appartient-elle à la série `wantKey` ?
 *  - **461$t fait autorité** quand il existe : c'est le lien « fait partie de » posé par le
 *    catalogueur. Un spin-off dont le 200$a répète le titre principal mais rattaché à un autre
 *    ensemble serait sinon accepté — et volerait les numéros de la série ;
 *  - **sans 461** (pré-notice, catalogage partiel) : **l'un des** 500$a, 200$a ou 225$a. On ne prend
 *    plus « le premier champ non vide de la chaîne » : sur une pré-notice Glénat, 225$a vaut
 *    « Shonen manga » (collection de l'éditeur) et excluait le tome le plus récent ; inversement, une
 *    notice où 225$a porte la série et 500$a le titre japonais doit rester membre.
 */
export function belongsToSeries(r: EditionRecord, wantKey: string): boolean {
  if (!wantKey) return false;
  if (r.setKey) return r.setKey === wantKey;
  return (
    r.uniformKey === wantKey ||
    r.titleKey === wantKey ||
    r.collectionKey === wantKey
  );
}

/**
 * Mots-clés d'édition d'art d'une notice **sans 205** (pré-notice), lus dans son titre propre une
 * fois retirés les mots du titre de série : « Hellsing perfect edition » (série « hellsing ») →
 * `perfect` ; mais « Perfect World » (série « perfect world ») → aucun — sans ce retrait, toute
 * l'édition standard d'une série dont le titre contient un mot-clé d'art disparaissait. Retrait en
 * multi-ensemble : « Perfect World perfect edition » garde un `perfect`.
 */
export function inferredArtKeywords(
  r: EditionRecord,
  seriesKey: string,
): string[] {
  if (!r.titleText) return [];
  const remaining = r.titleText.split(' ');
  for (const word of seriesKey.split(' ')) {
    const i = remaining.indexOf(word);
    if (i !== -1) remaining.splice(i, 1);
  }
  return artEditionKeywords(remaining.join(' '));
}

/**
 * N° de tome de la notice **dans la série `wantKey`**. `461$v` / `225$v` ne sont crus que si leur
 * titre est celui de la série : le `$v` d'une collection éditeur (« Shonen manga ; 123 ») est un
 * numéro de collection, pas un n° de tome. Ki-oon met le n° en 461$v/225$v (pas de 200$h).
 */
export function volumeOf(r: EditionRecord, wantKey: string): number | null {
  if (r.setKey === wantKey) {
    const v = parseVolume(r.setVolume);
    if (v !== null) return v;
  }
  if (r.collectionKey === wantKey) {
    const v = parseVolume(r.collectionVolume);
    if (v !== null) return v;
  }
  return parseVolume(r.titleVolume);
}

/**
 * La notice relève-t-elle de l'édition demandée (205 normalisé) ? Une pré-notice sans 205 dont le
 * titre — hors titre de série `seriesKey` — porte un mot-clé d'art n'est **pas** standard : elle
 * rejoint l'édition d'art qui partage ce mot-clé (« perfect »), sinon aucune.
 */
export function matchesEdition(
  r: EditionRecord,
  wantEditionKey: string,
  wantEditionRaw: string | null,
  seriesKey: string,
): boolean {
  const inferred = inferredArtKeywords(r, seriesKey);
  if (inferred.length > 0) {
    if (!wantEditionKey) return false;
    const wanted = artEditionKeywords(wantEditionRaw);
    return inferred.some((k) => wanted.includes(k));
  }
  return r.editionKey === wantEditionKey;
}

/** Éditeur dominant d'une édition et les n° de tome qu'il porte. */
export interface DominantPublisher {
  key: string | null;
  volumes: Set<number>;
}

/**
 * Éditeur **dominant** parmi des notices d'une même édition : celui qui porte le plus de tomes
 * numérotés distincts (à égalité, le premier rencontré). Défaut quand l'appelant ne précise pas
 * l'éditeur — le scan, qui ne le transmettait pas : sans ce choix, les 2-en-1 France Loisirs
 * (« 11-12 ») prenaient la place des tomes Pika de même numéro. Ses n° servent à
 * {@link keepForDominant}.
 */
export function dominantPublisher(
  records: EditionRecord[],
  wantKey: string,
): DominantPublisher {
  const volumesByPublisher = new Map<string, Set<number>>();
  for (const r of records) {
    const v = volumeOf(r, wantKey);
    if (v === null) continue;
    const set = volumesByPublisher.get(r.publisherKey) ?? new Set<number>();
    set.add(v);
    volumesByPublisher.set(r.publisherKey, set);
  }
  let best: DominantPublisher = { key: null, volumes: new Set() };
  for (const [key, volumes] of volumesByPublisher) {
    if (volumes.size > best.volumes.size) best = { key, volumes };
  }
  return best;
}

/**
 * Garde-t-on la notice quand l'éditeur n'est **pas** précisé ? Le dominant ne gagne que les
 * **collisions** : un autre libellé d'éditeur n'est écarté que s'il porte un n° que le dominant a
 * déjà (le 2-en-1 « 11-12 » face au T11 Pika). Un n° que seul un autre libellé porte comble un trou —
 * typiquement un changement de raison sociale en cours de série (Tonkam → Delcourt-Tonkam) — et
 * reste. Avec un éditeur explicite, le filtre reste strict (cf. `BnfService.enumerateEdition`).
 */
export function keepForDominant(
  r: EditionRecord,
  wantKey: string,
  dominant: DominantPublisher,
): boolean {
  if (r.publisherKey === dominant.key) return true;
  const v = volumeOf(r, wantKey);
  return v !== null && !dominant.volumes.has(v);
}

/**
 * Projette des notices en **éditions** : groupe par (série, éditeur, 205$a), une ligne par groupe
 * ayant au moins un tome numéroté. `matchKeys` = titres connus de la série (FR, romaji, alt-titres
 * MangaDex, saisie) normalisés ; `authorNames` = auteurs MangaDex, qui écartent un homonyme
 * catalogué (un roman dérivé, une autre œuvre du même titre) quand le groupe a des auteurs.
 */
export function projectEditions(
  records: EditionRecord[],
  matchKeys: Set<string>,
  authorNames: string[],
): EditionSummary[] {
  interface Group {
    seriesKey: string;
    publisherKey: string;
    editionKey: string;
    titles: string[];
    publishers: string[];
    editions: string[];
    volumes: Map<number, EditionRecord>;
    authors: BnfAuthor[];
    years: number[];
    ongoing: boolean;
    hasRange: boolean;
  }
  const groups = new Map<string, Group>();
  const pendingArt: {
    r: EditionRecord;
    seriesKey: string;
    keywords: string[];
  }[] = [];

  for (const r of records) {
    const groupTitle = groupTitleFor(r, matchKeys);
    if (groupTitle === null) continue;
    const seriesKey = normalizeSeriesKey(groupTitle);
    const keywords = inferredArtKeywords(r, seriesKey);
    if (keywords.length > 0) {
      pendingArt.push({ r, seriesKey, keywords }); // rattachée plus bas à une édition d'art
      continue;
    }
    addToGroup(groups, r, groupTitle, r.editionKey);
  }

  // Pré-notices d'art : rejoignent le groupe du même éditeur dont la mention 205 partage un
  // mot-clé ; sans groupe correspondant, elles attendent leur catalogage (ignorées).
  for (const { r, seriesKey, keywords } of pendingArt) {
    const target = [...groups.values()].find(
      (g) =>
        g.seriesKey === seriesKey &&
        g.publisherKey === r.publisherKey &&
        g.editionKey !== '' &&
        artEditionKeywords(g.editions[0] ?? null).some((k) =>
          keywords.includes(k),
        ),
    );
    if (target) addRecord(target, r);
  }

  const out: EditionSummary[] = [];
  for (const g of groups.values()) {
    if (g.volumes.size === 0) continue;
    if (
      g.authors.length > 0 &&
      authorNames.length > 0 &&
      !matchesAuthor(g.authors, authorNames)
    ) {
      continue; // homonyme : même titre, autre œuvre (roman dérivé, guide d'un autre auteur…)
    }
    const sortedVolumes = [...g.volumes.keys()].sort((a, b) => a - b);
    const edition = mostFrequent(g.editions);
    out.push({
      seriesTitleFr: mostFrequent(g.titles) ?? '',
      publisher: displayPublisher(mostFrequent(g.publishers)),
      edition,
      isArtEdition: isSpecialArtEdition(edition),
      tomeCount: g.volumes.size,
      firstYear: g.years.length ? String(Math.min(...g.years)) : null,
      lastYear: g.years.length ? String(Math.max(...g.years)) : null,
      ongoing: g.ongoing,
      hasSourceVolumeRange: g.hasRange,
      sampleIsbn: g.volumes.get(sortedVolumes[0])?.isbn ?? null,
    });
  }
  return out.sort(
    (a, b) =>
      b.tomeCount - a.tomeCount ||
      (a.publisher ?? '').localeCompare(b.publisher ?? ''),
  );

  function addToGroup(
    all: Map<string, Group>,
    r: EditionRecord,
    groupTitle: string,
    editionKey: string,
  ): void {
    const seriesKey = normalizeSeriesKey(groupTitle);
    const id = `${seriesKey}|${r.publisherKey}|${editionKey}`;
    let g = all.get(id);
    if (!g) {
      g = {
        seriesKey,
        publisherKey: r.publisherKey,
        editionKey,
        titles: [],
        publishers: [],
        editions: [],
        volumes: new Map(),
        authors: [],
        years: [],
        ongoing: false,
        hasRange: false,
      };
      all.set(id, g);
    }
    g.titles.push(groupTitle);
    addRecord(g, r);
  }

  function addRecord(g: Group, r: EditionRecord): void {
    if (r.publisher) g.publishers.push(r.publisher);
    if (r.edition) g.editions.push(r.edition);
    g.authors.push(...r.authors);
    const v = volumeOf(r, g.seriesKey);
    if (v !== null && !g.volumes.has(v)) g.volumes.set(v, r);
    const year = r.date?.match(/\d{4}/)?.[0];
    if (year) g.years.push(Number(year));
    if (isOngoing(r.date)) g.ongoing = true;
    if (r.sourceVolumeRange) g.hasRange = true;
  }
}

/**
 * Titre de série sous lequel ranger la notice, ou `null` si elle n'appartient à aucune série
 * recherchée — avec la même règle d'appartenance que {@link belongsToSeries}, sans quoi une édition
 * listée ne se rejouerait pas dans `edition-mapping` :
 *  - avec 461 : sous le 461$t (qui fait autorité), si lui-même, le titre uniforme ou le titre
 *    original (requête en romaji) égale une clé recherchée ;
 *  - sans 461 : sous le champ FR qui égale une clé (200$a, puis 225$a) ; une notice reconnue par son
 *    seul titre uniforme ou original est rangée sous son 200$a.
 */
function groupTitleFor(
  r: EditionRecord,
  matchKeys: Set<string>,
): string | null {
  const viaOriginal =
    (!!r.uniformKey && matchKeys.has(r.uniformKey)) ||
    (!!r.originalKey && matchKeys.has(r.originalKey));
  if (r.setKey) {
    return matchKeys.has(r.setKey) || viaOriginal ? r.rawSetTitle : null;
  }
  if (r.titleKey && matchKeys.has(r.titleKey)) return r.rawTitle;
  if (r.collectionKey && matchKeys.has(r.collectionKey)) {
    return r.rawCollection;
  }
  return viaOriginal ? r.rawTitle : null;
}

function mostFrequent(values: string[]): string | null {
  const counts = new Map<string, number>();
  let best: string | null = null;
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Normalisations
// ---------------------------------------------------------------------------------------------

/** Clé de série normalisée (minuscules, sans accents ni ponctuation) pour comparer
 * l'appartenance : "Maid sama !" et "Maid sama" → "maid sama". */
export function normalizeSeriesKey(raw: string | null): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "Éd. colossale" → "colossale" ; null/standard → "". Pour comparer les éditions. */
export function normalizeEdition(raw: string | null): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\b(ed|edition)\.?\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Mots génériques d'un nom d'éditeur, sans valeur distinctive : « Pika éd. », « Pika édition » et
 * « Pika » sont le même éditeur ; « Pika roman » reste une autre marque (un autre catalogue).
 */
const GENERIC_PUBLISHER_WORDS = new Set([
  'ed',
  'eds',
  'edition',
  'editions',
  'editeur',
  'editeurs',
]);

function publisherToken(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9@]+/g, '');
}

/** Clé d'éditeur : minuscules, sans accents ni ponctuation, mots génériques retirés. */
export function normalizePublisher(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .split(/[\s,;:()[\]/-]+/)
    .map(publisherToken)
    .filter((t) => t.length > 0 && !GENERIC_PUBLISHER_WORDS.has(t))
    .join(' ');
}

/** Libellé d'éditeur lisible : mots génériques retirés, casse et accents conservés. */
export function displayPublisher(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const kept = raw
    .split(/\s+/)
    .filter((w) => !GENERIC_PUBLISHER_WORDS.has(publisherToken(w)))
    .join(' ')
    .replace(/^[\s,;:.]+|[\s,;:]+$/g, '')
    .trim();
  return kept.length > 0 ? kept : raw.trim();
}

/** "1" → 1 ; "31" → 31 ; "T. 5" → 5 ; "vol. 22" → 22 ; non numérique → null. */
export function parseVolume(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/\d+/);
  return m ? Number(m[0]) : null;
}

/** "vol. 1-3" / "T. 1-3" / "1-3" → "1-3". null si rien d'exploitable. */
export function normalizeVolumeRange(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/vol\.?|tomes?|t\.?/gi, '')
    .replace(/\s+/g, '')
    .trim();
  return /\d/.test(cleaned) ? cleaned : null;
}

/** Date ouverte type "2015-" / "DL 2015-" → série en cours. */
export function isOngoing(date: string | null): boolean {
  if (!date) return false;
  return /\d{4}\s*-\s*$/.test(date.trim());
}

/** `100$a` ("20260728d2026 …") → "2026-07-28" ; null si les 8 premiers caractères ne sont pas une date. */
export function noticeCreationDate(raw: string | undefined): string | null {
  const m = raw?.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ---------------------------------------------------------------------------------------------
// Champs de notice
// ---------------------------------------------------------------------------------------------

/** Premier sous-champ `code` parmi les zones `tags` (dans l'ordre), toutes occurrences comprises :
 * une 214 d'imprimeur (« impr. en Espagne », sans $c) ne masque pas la 214 d'éditeur. */
export function firstSubfieldAmong(
  rec: UnimarcRecord,
  tags: string[],
  code: string,
): string | null {
  for (const tag of tags) {
    for (const df of allDatafields(rec, tag)) {
      const v = subfieldOf(df, code);
      if (v) return v;
    }
  }
  return null;
}

/** Relation de traducteur en zone 7xx : code 730, ou mention libre (pré-notices éditeur). */
function isTranslator(df: ReturnType<typeof allDatafields>[number]): boolean {
  const relator = subfieldOf(df, '4');
  if (relator === '730') return true;
  const role = [subfieldOf(df, 'c'), relator].filter(Boolean).join(' ');
  return /trad/i.test(role);
}

/**
 * Auteurs d'une notice : 700/701 (responsabilité principale), puis **702** (secondaire) — c'est
 * là que la pré-notice place l'auteur (`702 $a Suzuki $b Yūto`). Les traducteurs (702 aussi) sont
 * écartés : ils ne disent rien de l'œuvre et brouilleraient la validation MangaDex par l'auteur.
 * Repli sur 200$f quand aucune zone 7xx n'est exploitable.
 */
export function extractAuthors(rec: UnimarcRecord): BnfAuthor[] {
  const authors: BnfAuthor[] = [];
  for (const df of [
    ...allDatafields(rec, '700'),
    ...allDatafields(rec, '701'),
    ...allDatafields(rec, '702'),
  ]) {
    if (df.tag === '702' && isTranslator(df)) continue;
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
