import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ItemUserDataSchema } from './item-user-data.schema';

const UNIFIED_DATA_MAX_BYTES = 32_000;

const boundedJsonRecord = (maxBytes: number, field: string) =>
  z
    .record(z.unknown())
    .refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= maxBytes, {
      message: `${field} must be ≤${maxBytes} bytes once serialized`,
    });

// Curation : `unifiedData` (re-validée par le profil) et/ou `userData` (perso, merge PATCH).
// Les deux sont optionnels — un PATCH peut ne toucher que l'un des deux.
export const UpdateItemSchema = z
  .object({
    unifiedData: boundedJsonRecord(
      UNIFIED_DATA_MAX_BYTES,
      'unifiedData',
    ).optional(),
    userData: ItemUserDataSchema.optional(),
  })
  .strict()
  .refine((v) => v.unifiedData !== undefined || v.userData !== undefined, {
    message: 'at least one of unifiedData or userData must be provided',
  });

export class UpdateItemDto extends createZodDto(UpdateItemSchema) {}
