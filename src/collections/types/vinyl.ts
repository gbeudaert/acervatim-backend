import { z } from 'zod';
import { CollectionTypeProfile, ItemProjectionRow, LightItem } from './common';

// vinyl — type plat (pas de hiérarchie).
export const VinylItemSchema = z
  .object({
    type: z.literal('vinyl'),
    title: z.string().min(1).max(512),
    creators: z.array(z.string().max(256)).default([]),
    genre: z.array(z.string().max(64)).default([]),
    label: z.string().max(256).optional(),
    format: z.string().max(64).optional(),
    releaseDate: z.string().date().nullable().default(null),
    coverUrl: z.string().url().nullable().default(null),
  })
  .strict();

export const vinylProfile: CollectionTypeProfile = {
  code: 'vinyl',
  itemSchema: VinylItemSchema,
  hierarchy: [],
  toListProjection(row: ItemProjectionRow): LightItem {
    const u = row.unifiedData;
    return {
      id: row.id,
      type: 'vinyl',
      title: u.title ?? null,
      coverUrl: u.coverUrl ?? null,
      creators: u.creators ?? [],
      genre: u.genre ?? [],
      releaseDate: u.releaseDate ?? null,
    };
  },
};
