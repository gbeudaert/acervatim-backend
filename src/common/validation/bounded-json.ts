import { z } from 'zod';

/**
 * Plafond de taille du `unifiedData` d'un item ou d'un nœud, une fois sérialisé.
 *
 * Ce n'est pas une règle métier : la forme de `unifiedData` dépend du profil de type et sa
 * validation fine appartient au profil (`collections/types/`). Ici on ne garde qu'un garde-fou de
 * volume, pour qu'aucun client ne puisse pousser une colonne JSON arbitrairement grosse.
 */
export const UNIFIED_DATA_MAX_BYTES = 32_000;

/** Objet JSON libre, borné à [maxBytes] octets une fois sérialisé. */
export const boundedJsonRecord = (maxBytes: number, field: string) =>
  z
    .record(z.unknown())
    .refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= maxBytes, {
      message: `${field} must be ≤${maxBytes} bytes once serialized`,
    });
