import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Clé API TMDB personnelle (BYOT). TMDB v3 = 32 caractères hex ; on reste tolérant
// (v4 read access token possible) sans valider le format côté serveur — une clé
// invalide échouera au premier appel réel (décision Q-d : pas de ping à la saisie).
export const SetTmdbTokenSchema = z
  .object({
    token: z.string().trim().min(1).max(256),
  })
  .strict();

export class SetTmdbTokenDto extends createZodDto(SetTmdbTokenSchema) {}
