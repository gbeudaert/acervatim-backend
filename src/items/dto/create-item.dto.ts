import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const UNIFIED_DATA_MAX_BYTES = 32_000;
const MAX_SOURCES = 20;

const boundedJsonRecord = (maxBytes: number, field: string) =>
  z
    .record(z.unknown())
    .refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= maxBytes, {
      message: `${field} must be ≤${maxBytes} bytes once serialized`,
    });

// Référence d'une source candidate. `provider` libre (un adapter peut exister ou non :
// mal/discogs/tmdb → snapshot ; isbn/anilist → réf sans snapshot).
const SourceRefSchema = z
  .object({
    provider: z.string().min(1).max(32),
    externalId: z.string().min(1).max(128),
  })
  .strict();

export const CreateItemSchema = z
  .object({
    // Série parente (types hiérarchiques uniquement) — upsert si absente.
    node: SourceRefSchema.optional(),
    // N° de tome (types hiérarchiques uniquement).
    volume: z.number().int().nonnegative().optional(),
    // Vérité curée — validée ensuite par le profil du type (discriminant forcé).
    unifiedData: boundedJsonRecord(UNIFIED_DATA_MAX_BYTES, 'unifiedData'),
    // Sources propres à l'item (ex. isbn) — snapshot si adapter.
    sources: z.array(SourceRefSchema).max(MAX_SOURCES).optional(),
  })
  .strict();

export class CreateItemDto extends createZodDto(CreateItemSchema) {}
