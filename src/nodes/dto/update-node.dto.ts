import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  boundedJsonRecord,
  UNIFIED_DATA_MAX_BYTES,
} from '../../common/validation/bounded-json';
import { nodeUserDataShape } from './node-user-data.schema';

export const UpdateNodeSchema = z
  .object({
    // Vérité curée du nœud (re-validée par le nodeSchema du niveau).
    unifiedData: boundedJsonRecord(
      UNIFIED_DATA_MAX_BYTES,
      'unifiedData',
    ).optional(),
    // userData du nœud, à plat dans le corps du PATCH (cf. node-user-data.schema.ts).
    note: nodeUserDataShape.note.optional(),
    comment: nodeUserDataShape.comment.optional(),
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
