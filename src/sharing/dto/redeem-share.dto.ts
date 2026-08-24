import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { shareLabel } from './share-label';

export const RedeemShareSchema = z
  .object({
    code: z.string().min(8).max(64),
    /**
     * Libellé que le MEMBRE donne au partage qu'il rejoint. Optionnel ici, et modifiable ensuite
     * par `PATCH /v1/shares/received/:shareId` : on ne bloque pas l'adhésion sur un champ de confort.
     */
    label: shareLabel().optional(),
  })
  .strict();

export class RedeemShareDto extends createZodDto(RedeemShareSchema) {}
