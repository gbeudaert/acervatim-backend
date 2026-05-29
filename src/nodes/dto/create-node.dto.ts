import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const SourceRefSchema = z
  .object({
    provider: z.string().min(1).max(32),
    externalId: z.string().min(1).max(128),
  })
  .strict();

export const CreateNodeSchema = z
  .object({
    level: z.string().min(1).max(32),
    // Source candidate pré-remplissant le nœud (enrichi si un adapter existe).
    source: SourceRefSchema,
    isWishlist: z.boolean().optional(),
  })
  .strict();

export class CreateNodeDto extends createZodDto(CreateNodeSchema) {}
