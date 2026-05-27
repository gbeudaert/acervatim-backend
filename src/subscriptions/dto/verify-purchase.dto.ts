import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const VerifyPurchaseSchema = z.object({
  purchaseToken: z.string().min(1).max(512),
  productId: z.string().min(1).max(64),
});

export class VerifyPurchaseDto extends createZodDto(VerifyPurchaseSchema) {}
