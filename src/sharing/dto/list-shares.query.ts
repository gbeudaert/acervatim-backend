import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ListSharesQuerySchema = z
  .object({
    /** Ne garder que les partages exposant cette collection (écran ancré sur une collection). */
    collectionId: z.string().uuid().optional(),
  })
  .strict();

export class ListSharesQueryDto extends createZodDto(ListSharesQuerySchema) {}
