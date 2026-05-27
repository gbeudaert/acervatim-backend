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
    q: z.string().min(1).max(200),
    type: z.enum(COLLECTION_TYPE_CODES),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export class SearchQueryDto extends createZodDto(SearchQuerySchema) {}
