import { z } from 'zod';

/**
 * `userData` d'un nœud : pendant de `ItemUserDataSchema` au niveau série/set.
 *
 * Particularité du contrat V1 : contrairement à l'item, ces champs voyagent **à plat** dans le
 * corps du PATCH (`{ note, comment }`, pas `{ userData: { … } }`) — forme historique consommée
 * telle quelle par `PatchNodeRequest` côté app. On garde la forme du wire, mais une seule
 * définition de validation : `nodeUserDataShape` sert à la fois au schéma d'objet (ci-dessous) et
 * au DTO de mise à jour, pour qu'aucune règle ne diverge entre les deux.
 */
export const nodeUserDataShape = {
  note: z.number().int().min(0).max(10).nullable(), // appréciation 0–10 (null = non notée)
  comment: z.string().max(4000).nullable(), // commentaire libre sur la série
};

// `.partial()` → sémantique PATCH : seules les clés envoyées sont mises à jour (merge côté service).
export const NodeUserDataSchema = z
  .object(nodeUserDataShape)
  .strict()
  .partial();

export type NodeUserData = z.infer<typeof NodeUserDataSchema>;
