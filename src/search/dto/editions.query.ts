import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Query de `GET /v1/search/editions` : éditions françaises (BnF) de la série MangaDex choisie après
 * une recherche texte.
 */
export const EditionsQuerySchema = z
  .object({
    // id MangaDex du candidat choisi (`sourceId` du résultat de recherche). UUID : il est inséré
    // dans l'URL de l'API MangaDex.
    mangaId: z.string().uuid(),
    // Saisie de l'utilisateur, essayée à la BnF après le titre FR connu de MangaDex : un alt-titre
    // FR peut manquer côté MangaDex alors que l'utilisateur l'a tapé. Optionnel.
    title: z.string().min(1).max(256).optional(),
  })
  .strict();

export class EditionsQueryDto extends createZodDto(EditionsQuerySchema) {}
