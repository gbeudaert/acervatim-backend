import { z } from 'zod';
import { resolveItemStatus } from '../../items/dto/item-user-data.schema';
import { UnifiedItem } from '../../oauth/providers/types';
import {
  CollectionTypeProfile,
  HierarchyLevel,
  ItemProjectionRow,
  LightItem,
  optionalUrl,
} from './common';

// TOME (item). `volume` est une colonne structurelle, pas dans unifiedData.
// `title` optionnel → sinon dérivé "{série} — T.{volume}".
export const MangaItemSchema = z
  .object({
    type: z.literal('manga'),
    title: z.string().max(512).optional(),
    coverUrl: optionalUrl(),
    // Éditeur de l'édition française du tome.
    publisherFr: z.string().max(256).nullable().default(null),
    // Nombre de pages du tome.
    pageCount: z.number().int().positive().nullable().default(null),
    // Plage de tomes de l'édition SOURCE couverte par ce tome FR (BnF 454$h).
    // Ex "1-3" pour un tome d'édition Colossale qui compile les tomes 1 à 3 de
    // l'édition standard. null = édition standard (mapping 1:1).
    sourceVolumeRange: z.string().max(64).nullable().default(null),
  })
  .strict();

// SÉRIE (nœud), pré-rempli via MalAdapter.fetchDetails.
export const MangaSerieSchema = z
  .object({
    title: z.string().min(1).max(256),
    author: z.string().max(256).nullable().default(null),
    status: z
      .enum(['ongoing', 'finished', 'hiatus', 'unknown'])
      .default('unknown'),
    totalCount: z.number().int().nonnegative().nullable().default(null), // num_volumes
    rating: z.number().min(0).max(10).nullable().default(null), // mean
    // Démographie cible de la série (propriété série, pas tome).
    demographic: z
      .enum(['shonen', 'shojo', 'seinen', 'josei', 'kodomo', 'other'])
      .nullable()
      .default(null),
    synopsis: z.string().max(4000).nullable().default(null),
    coverUrl: optionalUrl(),
  })
  .strip();

type MangaSerieStatus = z.infer<typeof MangaSerieSchema>['status'];

// MAL : 'currently_publishing' | 'finished' | 'on_hiatus' | 'discontinued' | 'not_yet_published'.
function mapMalStatus(status: unknown): MangaSerieStatus {
  switch (status) {
    case 'currently_publishing':
      return 'ongoing';
    case 'finished':
      return 'finished';
    case 'on_hiatus':
      return 'hiatus';
    default:
      return 'unknown';
  }
}

const serieLevel: HierarchyLevel = {
  key: 'serie',
  label: 'Série',
  nodeSchema: MangaSerieSchema,
  mapSnapshot(s: UnifiedItem): Record<string, unknown> {
    const meta = s.metadata ?? {};
    return {
      title: s.title,
      author: s.creators[0] ?? null,
      status: mapMalStatus(meta.status),
      totalCount:
        typeof meta.num_volumes === 'number' && meta.num_volumes >= 0
          ? meta.num_volumes
          : null,
      rating: typeof meta.mean === 'number' ? meta.mean : null,
      synopsis: s.description ?? null,
      coverUrl: s.coverUrl ?? null,
    };
  },
};

export const mangaProfile: CollectionTypeProfile = {
  code: 'manga',
  itemSchema: MangaItemSchema,
  hierarchy: [serieLevel],
  toListProjection(row: ItemProjectionRow): LightItem {
    const u = row.unifiedData;
    const serie =
      typeof row.node?.unifiedData?.title === 'string'
        ? row.node.unifiedData.title
        : null;
    const title =
      typeof u.title === 'string' && u.title.length > 0
        ? u.title
        : serie && row.volume !== null
          ? `${serie} — T.${row.volume}`
          : null;
    return {
      id: row.id,
      type: 'manga',
      volume: row.volume,
      title,
      coverUrl: u.coverUrl ?? null,
      nodeId: row.nodeId,
      serie,
      // Statut du TOME (possédé/désiré) — sans rapport avec le `status` de la
      // série (ongoing/finished), qui n'est pas projeté ici.
      status: resolveItemStatus(row.userData),
    };
  },
};
