import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const UNIFIED_DATA_MAX_BYTES = 32_000;

const boundedJsonRecord = (maxBytes: number, field: string) =>
  z
    .record(z.unknown())
    .refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= maxBytes, {
      message: `${field} must be ≤${maxBytes} bytes once serialized`,
    });

// Curation : remplace la vérité curée `unifiedData` (re-validée par le profil du type).
export const UpdateItemSchema = z
  .object({
    unifiedData: boundedJsonRecord(UNIFIED_DATA_MAX_BYTES, 'unifiedData'),
  })
  .strict();

export class UpdateItemDto extends createZodDto(UpdateItemSchema) {}
