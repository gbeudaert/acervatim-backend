import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  boundedJsonRecord,
  UNIFIED_DATA_MAX_BYTES,
} from '../../common/validation/bounded-json';

const SourceRefSchema = z
  .object({
    provider: z.string().min(1).max(32),
    externalId: z.string().min(1).max(128),
  })
  .strict();

/**
 * Création d'un nœud (série manga, set…). Deux façons de le remplir, combinables :
 *
 * - `source` — référence provider. Si un adapter existe (MAL), son snapshot pré-remplit la vérité
 *   curée ; sinon (bnf, mangadex, isbn… : pas d'adapter) la référence est simplement conservée
 *   dans `sources[]`, sans snapshot.
 * - `unifiedData` — vérité curée fournie par le client, re-validée par le schéma du niveau. C'est
 *   le chemin de la **saisie manuelle** : une série que l'utilisateur a créée lui-même n'a aucune
 *   référence provider et ne peut pas être enrichie. Sans lui, elle ne serait pas synchronisable.
 *
 * Au moins l'un des deux est requis — un nœud sans identité ni contenu curé n'a rien à décrire.
 */
export const CreateNodeSchema = z
  .object({
    level: z.string().min(1).max(32),
    source: SourceRefSchema.optional(),
    unifiedData: boundedJsonRecord(
      UNIFIED_DATA_MAX_BYTES,
      'unifiedData',
    ).optional(),
    isWishlist: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.source !== undefined || v.unifiedData !== undefined, {
    message: 'source or unifiedData is required',
  });

export class CreateNodeDto extends createZodDto(CreateNodeSchema) {}
