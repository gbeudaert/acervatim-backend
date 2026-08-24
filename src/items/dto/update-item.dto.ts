import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  boundedJsonRecord,
  UNIFIED_DATA_MAX_BYTES,
} from '../../common/validation/bounded-json';
import { ItemUserDataSchema } from './item-user-data.schema';

// Curation : `unifiedData` (re-validée par le profil) et/ou `userData` (perso, merge PATCH).
// S'y ajoute l'identité structurelle d'un tome — `nodeId` et `volume` — sans quoi un changement
// de série ou de numéro resterait local : le miroir serveur garderait indéfiniment l'ancienne
// valeur. Les deux acceptent `null` (tome détaché de sa série, tome hors numérotation).
// Tout est optionnel — un PATCH peut ne toucher qu'un seul de ces champs.
export const UpdateItemSchema = z
  .object({
    unifiedData: boundedJsonRecord(
      UNIFIED_DATA_MAX_BYTES,
      'unifiedData',
    ).optional(),
    userData: ItemUserDataSchema.optional(),
    nodeId: z.string().uuid().nullable().optional(),
    volume: z.number().int().nonnegative().nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.unifiedData !== undefined ||
      v.userData !== undefined ||
      v.nodeId !== undefined ||
      v.volume !== undefined,
    { message: 'at least one field is required' },
  );

export class UpdateItemDto extends createZodDto(UpdateItemSchema) {}
