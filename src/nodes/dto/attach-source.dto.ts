import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const AttachNodeSourceSchema = z
  .object({
    provider: z.string().min(1).max(32),
    externalId: z.string().min(1).max(128),
  })
  .strict();

export class AttachNodeSourceDto extends createZodDto(AttachNodeSourceSchema) {}
