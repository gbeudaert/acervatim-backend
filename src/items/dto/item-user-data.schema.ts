import { z } from 'zod';

// `userData` d'un item : données perso/subjectives jamais providerisées (cf. CollectionNode.userData).
// Distinct de `unifiedData` (vérité curée comparable aux snapshots sources). Champs génériques,
// non type-spécifiques : un type qui ne les expose pas les laisse simplement absents.
// `.partial()` → sémantique PATCH : seules les clés envoyées sont mises à jour (merge côté service).
export const ItemUserDataSchema = z
  .object({
    rating: z.number().int().min(1).max(5).nullable(), // note 1–5 (null = non noté)
    purchasePrice: z.number().nonnegative().nullable(), // prix d'achat
    lastPlayedAt: z.string().datetime().nullable(), // dernière écoute (ISO-8601 UTC)
  })
  .strict()
  .partial();

export type ItemUserData = z.infer<typeof ItemUserDataSchema>;
