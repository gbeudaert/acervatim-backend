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
  })
  .strict()
  .partial();

export type ItemUserData = z.infer<typeof ItemUserDataSchema>;
