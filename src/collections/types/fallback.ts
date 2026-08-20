import { z } from 'zod';
import { resolveItemStatus } from '../../items/dto/item-user-data.schema';
import { CollectionTypeProfile, ItemProjectionRow, LightItem } from './common';

// Profil permissif pour les types non encore modélisés (movie/book/game) :
// `unifiedData` accepté tel quel (comportement sprint 03), type plat.
const PassthroughSchema = z.record(z.unknown());

export function makeFallbackProfile(code: string): CollectionTypeProfile {
  return {
    code,
    itemSchema: PassthroughSchema,
    hierarchy: [],
    toListProjection(row: ItemProjectionRow): LightItem {
      // `status` après le spread : le statut de possession prime sur un éventuel
      // `status` homonyme laissé passer par le schéma permissif.
      return {
        id: row.id,
        ...row.unifiedData,
        status: resolveItemStatus(row.userData),
      };
    },
  };
}
