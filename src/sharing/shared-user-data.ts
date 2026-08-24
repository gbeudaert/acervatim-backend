type JsonRecord = Record<string, unknown>;

/**
 * Champs de `userData` qu'un **membre** voit d'un item.
 *
 * Liste blanche, pas liste noire : un champ ajouté plus tard (S1bis en promet plusieurs) reste
 * invisible tant qu'on ne l'a pas explicitement jugé partageable. Le mode de défaillance est alors
 * « un champ manque dans une vue partagée », jamais « un champ privé a fuité ».
 *
 * Règle appliquée : passent l'appréciation et le fait de collection (`status` — indispensable au
 * filtrage —, `rating`, `lastPlayedAt`) ; ne passent ni le texte libre (`note`, qui peut contenir
 * n'importe quoi de personnel) ni le financier (`purchasePrice`).
 */
export const SHARED_ITEM_USER_DATA_KEYS = [
  'status',
  'rating',
  'lastPlayedAt',
] as const;

/**
 * Champs de `userData` qu'un membre voit d'un nœud (série).
 *
 * Même règle : `note` est ici une appréciation numérique 0-10 (à ne pas confondre avec le `note`
 * texte libre d'un item) et passe ; `comment` est du texte libre et ne passe pas.
 */
export const SHARED_NODE_USER_DATA_KEYS = ['note'] as const;

function project(userData: JsonRecord, keys: readonly string[]): JsonRecord {
  const out: JsonRecord = {};
  for (const key of keys) {
    if (key in userData) out[key] = userData[key];
  }
  return out;
}

/** `userData` d'item réduit à ce qu'un membre a le droit de voir. */
export function sharedItemUserData(userData: JsonRecord): JsonRecord {
  return project(userData, SHARED_ITEM_USER_DATA_KEYS);
}

/** `userData` de nœud réduit à ce qu'un membre a le droit de voir. */
export function sharedNodeUserData(userData: JsonRecord): JsonRecord {
  return project(userData, SHARED_NODE_USER_DATA_KEYS);
}
