import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ITEM_SOURCE_CODES } from '../item-source-codes';

export const CreateItemSchema = z
  .object({
    source: z.enum(ITEM_SOURCE_CODES),
    sourceId: z.string().min(1).max(128),
    unifiedData: z.record(z.unknown()),
    rawData: z.record(z.unknown()),
  })
  .strict();

export class CreateItemDto extends createZodDto(CreateItemSchema) {}
