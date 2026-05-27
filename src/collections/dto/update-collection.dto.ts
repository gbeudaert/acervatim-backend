import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateCollectionSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(10_000).nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'Au moins un champ à mettre à jour',
  });

export class UpdateCollectionDto extends createZodDto(UpdateCollectionSchema) {}
