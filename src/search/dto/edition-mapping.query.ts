import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Query de `GET /v1/search/edition-mapping` : énumère une édition manga
 * (« récupérer toute la série d'un coup ») via la BnF.
 */
export const EditionMappingQuerySchema = z
  .object({
    // Titre FR de la série (ex "L'attaque des titans"). Source : scannedTome.titleFr.
    title: z.string().min(1).max(256),
    // Mention d'édition 205 (ex "Éd. colossale"). Absent = édition standard.
    edition: z.string().max(128).optional(),
    // id MyAnimeList de la série (résolu par le pivot ISBN→MAL). Fiabilise le join MangaDex pour les
    // jaquettes par tome. Optionnel : sans lui, MangaDex valide le match par l'auteur BnF.
    malId: z.string().max(32).optional(),
    // id MangaDex de la série (identité produite au scan, metadata.pivot.mangaId). Join le plus fiable
    // des jaquettes par tome : utilisé tel quel, sans recherche par titre. Optionnel.
    mangaId: z.string().max(64).optional(),
  })
  .strict();

export class EditionMappingQueryDto extends createZodDto(
  EditionMappingQuerySchema,
) {}
