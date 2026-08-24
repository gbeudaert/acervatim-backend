import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { TECHNICAL_LIMITS } from '../../common/limits/limits.service';
import { ITEM_STATUSES } from '../../items/dto/item-user-data.schema';
import { shareLabel } from './share-label';

/** Une collection exposée par le partage, avec les statuts qu'elle laisse voir. */
export const ShareEntrySchema = z
  .object({
    collectionId: z.string().uuid(),
    /**
     * Non vide : un partage qui n'expose aucun statut d'une collection n'expose pas cette
     * collection — il faut alors ne pas l'inclure, ce que le client doit dire explicitement.
     */
    statuses: z.array(z.enum(ITEM_STATUSES)).min(1).max(ITEM_STATUSES.length),
  })
  .strict();

export const CreateShareSchema = z
  .object({
    /** Aide-mémoire du propriétaire. Jamais transmis aux membres. */
    label: shareLabel().optional(),
    /**
     * Bornée par le nombre de collections qu'un compte peut posséder : on peut tout partager,
     * jamais plus. Borne de validation contre un corps de requête absurde, pas limite produit.
     */
    collections: z
      .array(ShareEntrySchema)
      .min(1)
      .max(TECHNICAL_LIMITS.collections)
      .refine(
        (entries) =>
          new Set(entries.map((e) => e.collectionId)).size === entries.length,
        { message: 'a collection can only appear once in a share' },
      ),
    /**
     * Nombre de membres pouvant consommer le code. Le plafond 100 est une borne technique de
     * validation (un `maxUses` absurde n'a pas de sens), pas une limite produit : le nombre de
     * partages qu'un utilisateur peut créer n'est pas plafonné.
     */
    maxUses: z.number().int().min(1).max(100).optional(),
    /** epoch ms ; null/absent = le code ne périme jamais. */
    expiresAt: z.number().int().min(0).nullable().optional(),
  })
  .strict();

export class CreateShareDto extends createZodDto(CreateShareSchema) {}
