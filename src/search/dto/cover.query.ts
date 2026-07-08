import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Query de `GET /v1/search/cover` : résout la jaquette d'un tome par ISBN via Google Books.
 * `isbn` accepte tirets/espaces (ISBN-10/13 ou EAN) ; la normalisation est faite côté service.
 *
 * Repli par titre **optionnel** (`title` + `volume`, `edition` facultative) : quand la notice ISBN
 * n'a pas de jaquette (fréquent sur les ISBN papier FR), Google Books est ré-interrogé en
 * `intitle:<title> T<volume>`. Sans ces champs, seule la résolution `isbn:` est tentée et une absence
 * est mise en cache négatif — l'app devrait donc renvoyer les infos BnF du tome scanné.
 */
export const CoverQuerySchema = z
  .object({
    isbn: z
      .string()
      .min(10)
      .max(20)
      .regex(/^[0-9Xx][0-9Xx\s-]*$/, 'ISBN invalide'),
    // Titre FR de la série (ex "L'attaque des titans"). Requis avec `volume` pour armer le repli.
    title: z.string().min(1).max(256).optional(),
    // N° de tome dans l'édition. Coercition string→number (query param). Requis avec `title`.
    volume: z.coerce.number().int().positive().optional(),
    // Mention d'édition 205 (ex "Éd. colossale"). Absent = édition standard.
    edition: z.string().max(128).optional(),
  })
  .strict();

export class CoverQueryDto extends createZodDto(CoverQuerySchema) {}
