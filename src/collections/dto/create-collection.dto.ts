import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateCollectionSchema = z
  .object({
    typeCode: z.string().min(1).max(32),
    name: z.string().min(1).max(255),
    description: z.string().max(10_000).optional(),
  })
  .strict();

export class CreateCollectionDto extends createZodDto(CreateCollectionSchema) {}
