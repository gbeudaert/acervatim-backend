/**
 * Parseur UNIMARC / MarcXchange minimal, SANS dépendance externe.
 *
 * Pourquoi pas `fast-xml-parser` : le CLAUDE.md interdit l'ajout d'une dépendance
 * sans discussion préalable. On extrait seulement une poignée de zones connues
 * (datafields/subfields plats, pas de structure imbriquée) → une extraction ciblée
 * par regex est suffisante, testable sur fixtures, et évite la gymnastique de
 * namespace `mxc:` signalée comme piège dans le brief d'implémentation.
 *
 * Toutes les regex tolèrent un préfixe de namespace quelconque (`mxc:`, `srw:`, …)
 * via le motif `(?:[\w.-]+:)?`.
 */

export interface UnimarcSubfield {
  code: string;
  value: string;
}

export interface UnimarcDatafield {
  tag: string;
  ind1: string;
  ind2: string;
  subfields: UnimarcSubfield[];
}

export interface UnimarcRecord {
  /** controlfields indexés par tag (dernière occurrence gagne). */
  controlfields: Map<string, string>;
  datafields: UnimarcDatafield[];
}

export interface UnimarcParseResult {
  /** `<numberOfRecords>` annoncé par le serveur SRU (0 si absent). */
  numberOfRecords: number;
  /** Notices effectivement parsées (peut différer de numberOfRecords si pagination). */
  records: UnimarcRecord[];
}

const NS = '(?:[\\w.-]+:)?';
const NUM_RECORDS_RE = new RegExp(
  `<${NS}numberOfRecords>\\s*(\\d+)\\s*</${NS}numberOfRecords>`,
  'i',
);
const RECORD_DATA_RE = new RegExp(
  `<${NS}recordData\\b[^>]*>([\\s\\S]*?)</${NS}recordData>`,
  'gi',
);
const CONTROLFIELD_RE = new RegExp(
  `<${NS}controlfield\\b([^>]*)>([\\s\\S]*?)</${NS}controlfield>`,
  'gi',
);
const DATAFIELD_RE = new RegExp(
  `<${NS}datafield\\b([^>]*)>([\\s\\S]*?)</${NS}datafield>`,
  'gi',
);
const SUBFIELD_RE = new RegExp(
  `<${NS}subfield\\b([^>]*)>([\\s\\S]*?)</${NS}subfield>`,
  'gi',
);

function attr(rawAttrs: string, name: string): string {
  const m = rawAttrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : '';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // en dernier pour ne pas réintroduire d'entités
}

function parseSubfields(inner: string): UnimarcSubfield[] {
  const out: UnimarcSubfield[] = [];
  for (const m of inner.matchAll(SUBFIELD_RE)) {
    out.push({
      code: attr(m[1], 'code'),
      value: decodeEntities(m[2]).trim(),
    });
  }
  return out;
}

function parseRecord(block: string): UnimarcRecord {
  const controlfields = new Map<string, string>();
  for (const m of block.matchAll(CONTROLFIELD_RE)) {
    const tag = attr(m[1], 'tag');
    if (tag) controlfields.set(tag, decodeEntities(m[2]).trim());
  }

  const datafields: UnimarcDatafield[] = [];
  for (const m of block.matchAll(DATAFIELD_RE)) {
    datafields.push({
      tag: attr(m[1], 'tag'),
      ind1: attr(m[1], 'ind1'),
      ind2: attr(m[1], 'ind2'),
      subfields: parseSubfields(m[2]),
    });
  }

  return { controlfields, datafields };
}

export function parseUnimarc(xml: string): UnimarcParseResult {
  const numMatch = xml.match(NUM_RECORDS_RE);
  const numberOfRecords = numMatch ? parseInt(numMatch[1], 10) : 0;

  const records: UnimarcRecord[] = [];
  for (const m of xml.matchAll(RECORD_DATA_RE)) {
    records.push(parseRecord(m[1]));
  }

  return { numberOfRecords, records };
}

// ----- Accesseurs -----

export function controlfield(
  rec: UnimarcRecord,
  tag: string,
): string | undefined {
  return rec.controlfields.get(tag);
}

export function allDatafields(
  rec: UnimarcRecord,
  tag: string,
): UnimarcDatafield[] {
  return rec.datafields.filter((d) => d.tag === tag);
}

export function firstDatafield(
  rec: UnimarcRecord,
  tag: string,
): UnimarcDatafield | undefined {
  return rec.datafields.find((d) => d.tag === tag);
}

export function subfieldOf(
  df: UnimarcDatafield | undefined,
  code: string,
): string | undefined {
  const v = df?.subfields.find((s) => s.code === code)?.value;
  return v && v.length > 0 ? v : undefined;
}

/** Première valeur du sous-champ `code` du premier datafield `tag`. */
export function firstSubfield(
  rec: UnimarcRecord,
  tag: string,
  code: string,
): string | undefined {
  return subfieldOf(firstDatafield(rec, tag), code);
}
