import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { SHARE_SCOPES } from '../share-scope';

export const CreateShareSchema = z
  .object({
    scope: z.enum(SHARE_SCOPES),
    /**
     * Nombre de membres pouvant consommer le code. Le plafond 100 est une borne technique de
     * validation (un `maxUses` absurde n'a pas de sens), pas une limite produit : le nombre de
     * partages par collection reste non plafonné (cf. points ouverts de la spec macro).
     */
    maxUses: z.number().int().min(1).max(100).optional(),
    /** epoch ms ; null/absent = le code ne périme jamais. */
    expiresAt: z.number().int().min(0).nullable().optional(),
  })
  .strict();

export class CreateShareDto extends createZodDto(CreateShareSchema) {}
