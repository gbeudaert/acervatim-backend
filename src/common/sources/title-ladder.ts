/**
 * **Échelle de troncature** d'un titre commercial Google Books, pour le repli
 * `Google Books → MangaDex` (scan d'un ISBN que la BnF ne connaît pas).
 *
 * Le problème : le titre Google n'est pas normalisé (`One Piece Tome 112`, `Frieren`,
 * `Chainsaw Man Tome 18 . Edition collector`, du déchet de coffret…) et
 * `seriesInfo.bookDisplayNumber` est **vide sur les 137 tomes mesurés** — le n° de tome ne peut
 * donc venir que du titre. MangaDex, lui, ne tolère aucun bruit : `title=One Piece Tome 112`
 * renvoie `total=0`. On ne peut ni envoyer le titre brut, ni parser le n° de tome de façon fiable.
 *
 * La sortie : on retire les tokens **par la fin**, du titre complet au plus court, et on interroge
 * MangaDex à chaque échelon jusqu'au premier préfixe qui matche une vraie série. Le n° de tome
 * retenu est celui lu dans la queue retirée du préfixe **gagnant** — il n'est cru que parce que le
 * préfixe, lui, a matché.
 *
 * **Aucune liste de mots** (« Tome », « T. », « vol. »…) : les titres ne sont pas normalisés, une
 * liste serait fausse pour la moitié du corpus. Un seul garde-fou, non linguistique : on ne tronque
 * que si la queue retirée **contient un chiffre**, c'est-à-dire quand on retire plausiblement un
 * numéro de tome. Sans lui, `Instinct grégaire` (tome Ki-oon de Jujutsu Kaisen) se tronquerait en
 * `Instinct` et matcherait une série réellement nommée *Instinct*.
 */

/**
 * Profondeur maximale de troncature. `Chainsaw Man Tome 18 . Edition collector` demande 5 tokens
 * retirés ; au-delà de 6 on ne retire plus un n° de tome mais on ampute le titre.
 */
const MAX_CUT = 6;

/** Un préfixe trop court n'identifie plus rien (et matcherait n'importe quoi chez MangaDex). */
const MIN_PREFIX_LENGTH = 4;

/** Un échelon de l'échelle : ce qu'on interroge, et le n° de tome que ça implique. */
export interface TitleLadderStep {
  /** Préfixe à envoyer à MangaDex, ponctuation de bord retirée. */
  prefix: string;
  /** N° de tome lu dans la queue retirée — `null` au premier échelon, qui ne retire rien. */
  volume: number | null;
  /** Nombre de tokens retirés (0 = titre complet). Pour le log de diagnostic. */
  cut: number;
}

/**
 * Échelons à essayer, du titre complet au plus tronqué. Un titre d'un seul token n'en produit
 * qu'un (rien à retirer) ; un titre sans chiffre non plus (garde-fou ci-dessus).
 */
export function titleLadder(title: string): TitleLadderStep[] {
  const tokens = title
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  const steps: TitleLadderStep[] = [];
  const seen = new Set<string>();
  const maxCut = Math.min(MAX_CUT, tokens.length - 1);

  for (let cut = 0; cut <= maxCut; cut++) {
    const prefix = trimEdges(tokens.slice(0, tokens.length - cut).join(' '));
    const rest = tokens.slice(tokens.length - cut).join(' ');

    // Garde-chiffre + longueur minimale : ne s'appliquent qu'aux troncatures, jamais au titre
    // complet (échelon 0), qui est toujours tenté tel quel.
    if (cut > 0 && (!/\d/.test(rest) || prefix.length < MIN_PREFIX_LENGTH)) {
      continue;
    }
    if (!prefix) continue;

    // Deux échelons peuvent retomber sur le même préfixe quand la queue retirée n'était que de la
    // ponctuation de bord : inutile de re-interroger MangaDex avec la même chaîne.
    const key = prefix.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    steps.push({ prefix, volume: lastInteger(rest), cut });
  }

  return steps;
}

/** Retire espaces et ponctuation de bord (« Chainsaw Man Tome » ← « Chainsaw Man Tome . »). */
function trimEdges(s: string): string {
  return s.replace(/^[\s.,:;\-]+/, '').replace(/[\s.,:;\-]+$/, '');
}

/**
 * Dernier entier de la queue retirée — c'est lui le n° de tome : dans « Tome 18 . Edition
 * collector » comme dans « 16 », le nombre lu est celui du tome. `null` si la queue n'a aucun
 * chiffre (échelon 0, qui ne retire rien).
 */
function lastInteger(rest: string): number | null {
  const all = rest.match(/\d+/g);
  if (!all?.length) return null;
  const n = Number.parseInt(all[all.length - 1], 10);
  return Number.isFinite(n) ? n : null;
}
