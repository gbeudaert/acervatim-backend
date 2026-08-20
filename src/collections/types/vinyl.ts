import { z } from 'zod';
import { resolveItemStatus } from '../../items/dto/item-user-data.schema';
import {
  CollectionTypeProfile,
  ItemProjectionRow,
  LightItem,
  optionalUrl,
} from './common';

// vinyl — type plat (pas de hiérarchie).
const VinylItemBaseSchema = z
  .object({
    type: z.literal('vinyl'),
    title: z.string().min(1).max(512),
    creators: z.array(z.string().max(256)).default([]),
    // Pluriel volontaire : le serveur est le miroir, il ne doit pas perdre ce qu'un client
    // multi-genres lui enverrait. L'app Android n'en gère qu'un et pousse un tableau à un
    // élément (`genres.firstOrNull()` à la lecture) — sans perte côté serveur.
    genre: z.array(z.string().max(64)).default([]),
    label: z.string().max(256).optional(),
    format: z.string().max(64).optional(),
    // Vitesse de gravure (RPM), distincte du format physique.
    recordingSpeed: z
      .enum(['RPM_33', 'RPM_45', 'RPM_78', 'OTHER'])
      .nullable()
      .default(null),
    // Pays de pressage (libre, code ou nom).
    country: z.string().max(64).nullable().default(null),
    releaseDate: z.string().date().nullable().default(null),
    coverUrl: optionalUrl(),
  })
  .strict();

/**
 * `barcode` **n'est plus un champ curé** (S1bis) : la source de vérité unique du code-barres est
 * `sources[]` avec `provider: 'barcode'`, où l'app l'écrit déjà et d'où elle le relit. Le porter
 * aussi dans `unifiedData` faisait deux copies vouées à diverger, et c'est bien un identifiant
 * externe — la place des identifiants externes, c'est `sources[]`.
 *
 * Il est **retiré silencieusement** au lieu d'être rejeté : `unifiedData` étant remplacé en bloc au
 * PATCH, un client qui relit un item puis le repousse tel quel renverrait la clé stockée et se
 * prendrait un 400 sur une donnée qu'il n'a pas produite. Aucune perte : rien côté serveur
 * n'alimentait ce champ (l'adapter Discogs expose le code-barres dans `metadata`, pas ici).
 */
const stripDeprecatedBarcode = (v: unknown): unknown => {
  if (v !== null && typeof v === 'object' && 'barcode' in v) {
    const { barcode: _deprecated, ...rest } = v as Record<string, unknown>;
    return rest;
  }
  return v;
};

export const VinylItemSchema = z.preprocess(
  stripDeprecatedBarcode,
  VinylItemBaseSchema,
);

/** `YYYY-01-01` : la forme qu'émet un client qui ne modélise que l'année. */
const isJanuaryFirst = (date: string): boolean => date.endsWith('-01-01');

export const vinylProfile: CollectionTypeProfile = {
  code: 'vinyl',
  itemSchema: VinylItemSchema,
  hierarchy: [],
  /**
   * Protège `releaseDate` d'une perte de précision silencieuse (tranché en S1bis).
   *
   * L'app Android ne stocke qu'une année (`year: Int`) et repousse `"%04d-01-01"`. Une date
   * complète venant d'un provider (`released` chez Discogs, ex. `1959-08-17`) serait donc écrasée
   * en `1959-01-01` au premier push suivant — sans que personne ne l'ait demandé.
   *
   * Règle : on ne remplace jamais une date précise par le 1er janvier **de la même année**. Un
   * changement d'année reste un vrai changement et passe normalement.
   */
  reconcileOnUpdate(incoming, stored) {
    const next = incoming.releaseDate;
    const current = stored.releaseDate;
    if (
      typeof next === 'string' &&
      typeof current === 'string' &&
      isJanuaryFirst(next) &&
      !isJanuaryFirst(current) &&
      next.slice(0, 4) === current.slice(0, 4)
    ) {
      return { ...incoming, releaseDate: current };
    }
    return incoming;
  },
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
      status: resolveItemStatus(row.userData),
    };
  },
};
