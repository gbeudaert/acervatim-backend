import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Corps de `POST /v1/search/import-jobs` : lance l'import asynchrone d'une édition manga complète
 * (énumération BnF + jaquettes) en tâche de fond. Mêmes champs que `edition-mapping`.
 */
export const CreateImportJobSchema = z
  .object({
    // Titre FR de la série (ex "L'attaque des titans"). Source : scannedTome.titleFr.
    title: z.string().min(1).max(256),
    // Mention d'édition 205 (ex "Éd. colossale"). Absent = édition standard.
    edition: z.string().max(128).optional(),
    // id MyAnimeList (pivot ISBN→MAL) : fiabilise le join MangaDex des jaquettes. Optionnel.
    malId: z.string().max(32).optional(),
  })
  .strict();

export class CreateImportJobDto extends createZodDto(CreateImportJobSchema) {}
