import { z } from 'zod';

// Statut de possession d'un item, poussé par l'app (`ItemStatus` côté Kotlin).
// Sert de base au filtrage des partages par portée (OWNED / WANTLIST).
export const ITEM_STATUSES = ['OWNED', 'WISHLIST', 'IGNORED'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/**
 * Statut appliqué quand `userData.status` est absent ou `null` : les items
 * synchronisés avant l'ajout du champ sont considérés possédés (même défaut que
 * l'app, `?: ItemStatus.OWNED`) — pas de migration de données.
 */
export const DEFAULT_ITEM_STATUS: ItemStatus = 'OWNED';

/** Statut effectif d'un item à partir de son `userData` brut (JSON de la base). */
export function resolveItemStatus(userData: unknown): ItemStatus {
  const raw =
    typeof userData === 'object' && userData !== null
      ? (userData as Record<string, unknown>).status
      : undefined;
  return ITEM_STATUSES.includes(raw as ItemStatus)
    ? (raw as ItemStatus)
    : DEFAULT_ITEM_STATUS;
}

/**
 * Nombre d'écoutes appliqué quand `userData.playCount` est absent ou `null` :
 * un item d'avant le champ n'a jamais été compté, il vaut 0 (pas de migration).
 */
export const DEFAULT_PLAY_COUNT = 0;

/** Nombre d'écoutes effectif d'un item à partir de son `userData` brut (JSON de la base). */
export function resolvePlayCount(userData: unknown): number {
  const raw =
    typeof userData === 'object' && userData !== null
      ? (userData as Record<string, unknown>).playCount
      : undefined;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
    ? raw
    : DEFAULT_PLAY_COUNT;
}

// `userData` d'un item : données perso/subjectives jamais providerisées (cf. CollectionNode.userData).
// Distinct de `unifiedData` (vérité curée comparable aux snapshots sources). Champs génériques,
// non type-spécifiques : un type qui ne les expose pas les laisse simplement absents.
// `.partial()` → sémantique PATCH : seules les clés envoyées sont mises à jour (merge côté service).
export const ItemUserDataSchema = z
  .object({
    rating: z.number().int().min(1).max(5).nullable(), // note 1–5 (null = non noté)
    purchasePrice: z.number().nonnegative().nullable(), // prix d'achat
    lastPlayedAt: z.string().datetime().nullable(), // dernière écoute (ISO-8601 UTC)
    // Note libre/privée saisie par l'utilisateur (ex. description d'un tome).
    // Aucune source amont (MAL n'a pas de synopsis par tome) → vide par défaut.
    note: z.string().max(4000).nullable(),
    // Possédé / désiré / ignoré. `null` ou absent ⇒ DEFAULT_ITEM_STATUS.
    status: z.enum(ITEM_STATUSES).nullable(),
    // Nombre d'écoutes cumulé. `null` ou absent ⇒ DEFAULT_PLAY_COUNT (0).
    //
    // Le serveur est **déclaratif** : il enregistre la valeur absolue envoyée par le client sans
    // jamais l'incrémenter lui-même, ni la recouper avec `lastPlayedAt` (les deux décrivent le même
    // geste mais restent indépendants, comme le reste de `userData`, propriété du client).
    //
    // Limite assumée : le PATCH de `userData` est un merge de valeurs, pas un incrément. Deux
    // appareils qui écoutent hors ligne puis synchronisent s'écrasent mutuellement (dernier
    // écrivain gagne) au lieu de s'additionner. Introduire une opération d'incrément côté API
    // ferait une exception dans la sémantique de `userData` pour un cas marginal ; si la limite
    // devient gênante, c'est le signal qu'il fallait un historique d'écoutes, pas un compteur.
    playCount: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .partial();

export type ItemUserData = z.infer<typeof ItemUserDataSchema>;
