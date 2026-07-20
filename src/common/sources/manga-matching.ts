import { BnfAuthor } from './bnf/bnf.types';

/**
 * Helpers de **rapprochement manga** partagés par le pivot MAL ({@link MalAdapter}) et
 * l'identification MangaDex ({@link MangaDexResolver}). Extraits de `mal.adapter.ts` (DRY) : les deux
 * sources désambiguïsent un candidat par **similarité de titre** (romaji/FR) + **match auteur** avec
 * le même calibrage. On y ajoute {@link isSpecialArtEdition}, le garde-fou « édition d'art » qui
 * décide si une jaquette MangaDex par n° de tome est applicable (cf. plan MangaDex §3).
 */

/**
 * Seuil de similarité de titre (contenance/Dice) au-delà duquel un candidat manga est retenu SANS
 * match auteur. Calibré ~0.85 (cf. pivot MAL) : « titre-requête contenu dans le titre candidat » = 1.
 */
export const PIVOT_TITLE_STRONG = 0.85;

/** Normalise un nom : minuscules, sans accents/diacritiques. */
export function normName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** Tokens d'un nom (mots ≥ 2 lettres), pour comparer sans tenir compte de l'ordre. */
export function nameTokens(s: string | undefined | null): string[] {
  if (!s) return [];
  return normName(s)
    .split(/[\s,]+/)
    .filter((w) => w.length >= 2);
}

/**
 * Match auteur BnF ↔ candidat : vrai si au moins un token de nom (nom/prénom) est commun. Insensible
 * à la casse, aux accents et à l'ordre nom/prénom — c'est le validateur robuste du rapprochement (le
 * titre romaji peut matcher par chance, l'auteur confirme). Ex. BnF 700$a "Isayama" ↔ "Isayama".
 *
 * `candidateNames` : les noms d'auteurs de la source distante, sous forme de chaînes libres (MAL :
 * prénom + nom ; MangaDex : nom de relation author/artist). Chaque chaîne est re-tokenisée.
 */
export function matchesAuthor(
  bnfAuthors: BnfAuthor[],
  candidateNames: (string | undefined | null)[],
): boolean {
  if (!bnfAuthors?.length || !candidateNames?.length) return false;

  const candTokens = new Set(candidateNames.flatMap((n) => nameTokens(n)));
  if (candTokens.size === 0) return false;

  const bnfTokens = bnfAuthors.flatMap((a) => [
    ...nameTokens(a.surname),
    ...nameTokens(a.given),
    ...nameTokens(a.full),
  ]);

  return bnfTokens.some((t) => candTokens.has(t));
}

/**
 * Similarité titre requête↔candidat ∈ [0,1]. Contenance (une chaîne incluse dans l'autre, ex
 * "tokyo toritsu" ⊂ "jujutsu kaisen 0: tokyo toritsu…") → 1.0 ; sinon coefficient de Dice sur
 * bigrammes de caractères (fuzzy, tolère les variantes de romanisation type "jyouou"/"joou").
 * Normalisation : minuscules, sans diacritiques, espaces compactés.
 */
export function titleSimilarity(
  query: string,
  candidate: string | undefined,
): number {
  const q = normTitle(query);
  const c = normTitle(candidate ?? '');
  if (!q || !c) return 0;
  if (c.includes(q) || q.includes(c)) return 1;
  return diceCoefficient(q, c);
}

function normTitle(s: string): string {
  return normName(s).replace(/\s+/g, ' ').trim();
}

/** Coefficient de Dice sur bigrammes de caractères ∈ [0,1]. */
function diceCoefficient(a: string, b: string): number {
  const baseA = a.replace(/\s+/g, '');
  const baseB = b.replace(/\s+/g, '');
  if (baseA.length < 2 || baseB.length < 2) return baseA === baseB ? 1 : 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < baseA.length - 1; i++) {
    const bg = baseA.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
  }
  let overlap = 0;
  let totalB = 0;
  for (let i = 0; i < baseB.length - 1; i++) {
    totalB++;
    const bg = baseB.slice(i, i + 2);
    const count = bigrams.get(bg) ?? 0;
    if (count > 0) {
      bigrams.set(bg, count - 1);
      overlap++;
    }
  }
  const totalA = baseA.length - 1;
  return (2 * overlap) / (totalA + totalB);
}

/**
 * Mots-clés d'**édition d'art** (visuel ET numérotation distincts de l'édition standard). Le garde-fou
 * du pivot : sur ces éditions, la jaquette MangaDex indexée par (n° de tome) renvoie le VISUEL du
 * standard (mauvais) — on la saute. Normalisés (sans diacritiques) pour tester `normName(edition)`.
 */
const ART_EDITION_KEYWORDS = [
  'colossale',
  'prestige',
  'perfect',
  'deluxe',
  'luxe',
  'kanzenban',
  'collector',
  'integrale', // "intégrale" après retrait des diacritiques
  'coffret',
  'grand format',
  'ultimate',
  'edition originale',
];

/**
 * Vrai si la mention d'édition BnF (205$a) désigne une **édition d'art** — autre visuel ET autre
 * numérotation que le standard (Colossale, Perfect, Kanzenban, Prestige, deluxe/luxe, collector,
 * intégrale, coffret, grand format…). Sur ces éditions, on **saute MangaDex** (cf. plan §3).
 *
 * ⚠️ « édition d'art » ≠ « `edition != null` » : un **retirage** (`Quatorzième éd.`, `2e éd.`,
 * ordinaux de tirage) a le MÊME visuel standard → renvoie `false` (on garde MangaDex). C'est pourquoi
 * ce test cherche un mot-clé d'art plutôt que la simple présence d'une mention d'édition.
 */
export function isSpecialArtEdition(
  edition: string | null | undefined,
): boolean {
  if (!edition) return false;
  const norm = normName(edition);
  return ART_EDITION_KEYWORDS.some((k) => norm.includes(k));
}
