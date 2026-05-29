import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const UNIFIED_DATA_MAX_BYTES = 32_000;

const boundedJsonRecord = (maxBytes: number, field: string) =>
  z
    .record(z.unknown())
    .refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= maxBytes, {
      message: `${field} must be ≤${maxBytes} bytes once serialized`,
    });

export const UpdateNodeSchema = z
  .object({
    // Vérité curée du nœud (re-validée par le nodeSchema du niveau).
    unifiedData: boundedJsonRecord(
      UNIFIED_DATA_MAX_BYTES,
      'unifiedData',
    ).optional(),
    // userData : note + commentaire.
    note: z.number().int().min(0).max(10).nullable().optional(),
    comment: z.string().max(4000).nullable().optional(),
    // isWishlist=false sur un nœud vide → purge (204).
    isWishlist: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.unifiedData !== undefined ||
      v.note !== undefined ||
      v.comment !== undefined ||
      v.isWishlist !== undefined,
    { message: 'at least one field is required' },
  );

export class UpdateNodeDto extends createZodDto(UpdateNodeSchema) {}
