import { z } from 'zod';
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
      return { id: row.id, ...row.unifiedData };
    },
  };
}
