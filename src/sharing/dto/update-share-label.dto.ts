import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { shareLabel } from './share-label';

/**
 * Seul le libellé se modifie après coup. Re-scoper un partage vivant (changer ses collections ou
 * ses statuts) changerait silencieusement ce que ses membres voient : cela passe par la révocation
 * et un nouveau code, pour que le changement soit visible des deux côtés.
 */
export const UpdateShareLabelSchema = z
  .object({ label: shareLabel() })
  .strict();

export class UpdateShareLabelDto extends createZodDto(UpdateShareLabelSchema) {}
