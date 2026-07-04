import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Query de `GET /v1/search/cover` : résout la jaquette d'un tome par ISBN via Google Books.
 * `isbn` accepte tirets/espaces (ISBN-10/13 ou EAN) ; la normalisation est faite côté service.
 */
export const CoverQuerySchema = z
  .object({
    isbn: z
      .string()
      .min(10)
      .max(20)
      .regex(/^[0-9Xx][0-9Xx\s-]*$/, 'ISBN invalide'),
  })
  .strict();

export class CoverQueryDto extends createZodDto(CoverQuerySchema) {}
