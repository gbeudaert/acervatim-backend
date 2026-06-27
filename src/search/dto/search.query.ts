import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { COLLECTION_TYPE_CODES } from '../../collections/collection-type-codes';

/**
 * Le sprint demande d'étendre PaginationQuerySchema, mais celui-ci impose
 * `cursor: z.string().uuid()` — adapté aux pages DB internes, pas aux pages
 * des APIs externes (Discogs/MAL/TMDB renvoient des numéros ou des URLs).
 * On reconstruit le schéma localement avec un cursor opaque.
 */
export const SearchQuerySchema = z
  .object({
    // Recherche texte libre. Mutuellement exclusif avec `barcode`.
    q: z.string().min(1).max(200).optional(),
    // Code-barres (EAN-8/13, UPC-A). Digits only, longueur typique 8-14.
    // Seules les sources qui l'exposent répondent (cf. searchByBarcode) — sinon 400.
    barcode: z
      .string()
      .regex(/^\d{6,14}$/, 'barcode must be 6-14 digits')
      .optional(),
    type: z.enum(COLLECTION_TYPE_CODES),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((d) => (d.q ? 1 : 0) + (d.barcode ? 1 : 0) === 1, {
    message: 'exactly one of `q` or `barcode` is required',
    path: ['q'],
  });

export class SearchQueryDto extends createZodDto(SearchQuerySchema) {}
