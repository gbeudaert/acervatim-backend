import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const RedeemShareSchema = z
  .object({
    code: z.string().min(8).max(64),
  })
  .strict();

export class RedeemShareDto extends createZodDto(RedeemShareSchema) {}
