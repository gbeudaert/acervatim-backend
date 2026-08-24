import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  boundedJsonRecord,
  UNIFIED_DATA_MAX_BYTES,
} from '../../common/validation/bounded-json';
import { ItemUserDataSchema } from './item-user-data.schema';

const MAX_SOURCES = 20;

// Référence d'une source candidate. `provider` libre (un adapter peut exister ou non :
// mal/discogs/tmdb → snapshot ; isbn/anilist → réf sans snapshot).
const SourceRefSchema = z
  .object({
    provider: z.string().min(1).max(32),
    externalId: z.string().min(1).max(128),
  })
  .strict();

export const CreateItemSchema = z
  .object({
    // Série parente désignée par une référence provider — le nœud est upserté si absent.
    // Chemin des imports enrichis (MAL), qui ne connaissent pas encore l'id serveur du nœud.
    node: SourceRefSchema.optional(),
    // Série parente déjà créée (POST /collections/:id/nodes) désignée par son id. Chemin de la
    // synchronisation : le client pousse ses nœuds, puis ses items, comme collections → items.
    nodeId: z.string().uuid().optional(),
    // N° de tome (types hiérarchiques uniquement). `null` = tome hors numérotation (hors-série,
    // artbook) : le modèle app l'autorise, le refuser bloquerait sa synchronisation.
    volume: z.number().int().nonnegative().nullable().optional(),
    // Vérité curée — validée ensuite par le profil du type (discriminant forcé).
    unifiedData: boundedJsonRecord(UNIFIED_DATA_MAX_BYTES, 'unifiedData'),
    // Données perso/subjectives (rating, prix, dernière écoute) — optionnel.
    userData: ItemUserDataSchema.optional(),
    // Sources propres à l'item (ex. isbn) — snapshot si adapter.
    sources: z.array(SourceRefSchema).max(MAX_SOURCES).optional(),
  })
  .strict()
  .refine((v) => v.node === undefined || v.nodeId === undefined, {
    message: 'node and nodeId are mutually exclusive',
  });

export class CreateItemDto extends createZodDto(CreateItemSchema) {}
