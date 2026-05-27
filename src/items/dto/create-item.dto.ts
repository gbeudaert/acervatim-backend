import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ITEM_SOURCE_CODES } from '../item-source-codes';

const UNIFIED_DATA_MAX_BYTES = 32_000;
const RAW_DATA_MAX_BYTES = 64_000;

const boundedJsonRecord = (maxBytes: number, field: string) =>
  z
    .record(z.unknown())
    .refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= maxBytes, {
      message: `${field} must be ≤${maxBytes} bytes once serialized`,
    });

export const CreateItemSchema = z
  .object({
    source: z.enum(ITEM_SOURCE_CODES),
    sourceId: z.string().min(1).max(128),
    unifiedData: boundedJsonRecord(UNIFIED_DATA_MAX_BYTES, 'unifiedData'),
    rawData: boundedJsonRecord(RAW_DATA_MAX_BYTES, 'rawData'),
  })
  .strict();

export class CreateItemDto extends createZodDto(CreateItemSchema) {}
