import { z, ZodType } from 'zod';
import { UnifiedItem } from '../../oauth/providers/types';

/**
 * URL optionnelle tolérante : accepte une URL valide, `null`, l'absence, ou la
 * chaîne vide `""` (que certains clients envoient pour « pas de valeur »). `""`
 * est coercé en `null` avant validation. Défaut `null`.
 */
export const optionalUrl = () =>
  z.preprocess(
    (v) => (v === '' ? null : v),
    z.string().url().nullable().default(null),
  );

/** Référence d'une source candidate (provider + identifiant externe). */
export interface SourceRef {
  provider: string;
  externalId: string;
}

/**
 * Entrée stockée dans la colonne JSON `sources[]` (item ou nœud).
 * `rawData`/`fetchedAt` à `null` = référence sans snapshot (provider sans adapter,
 * ou saisie manuelle).
 */
export interface SourceEntry {
  provider: string;
  externalId: string;
  rawData: unknown | null;
  fetchedAt: string | null;
}

/** Vue publique d'une source dans les reads normaux — jamais de `rawData`. */
export interface SourceRefView {
  provider: string;
  externalId: string;
  fetchedAt: string | null;
}

export type LightItem = Record<string, unknown>;

/** Ligne minimale consommée par la projection légère (item + nœud éventuel). */
export interface ItemProjectionRow {
  id: string;
  nodeId: string | null;
  volume: number | null;
  unifiedData: Record<string, unknown>;
  /** Données perso — la projection n'en expose que le `status` (cf. resolveItemStatus). */
  userData: Record<string, unknown>;
  node: { unifiedData: Record<string, unknown> } | null;
}

export interface HierarchyLevel {
  key: string;
  label: string;
  /** Valide le `unifiedData` curé d'un nœud de ce niveau. */
  nodeSchema: ZodType;
  /** Mappe un snapshot provider (UnifiedItem) vers le `unifiedData` curé du nœud. */
  mapSnapshot(snapshot: UnifiedItem): Record<string, unknown>;
}

export interface CollectionTypeProfile {
  code: string;
  /** Valide `unifiedData` (descriptif curé) d'un item de ce type. */
  itemSchema: ZodType;
  /** Projection légère renvoyée en liste. */
  toListProjection(row: ItemProjectionRow): LightItem;
  /** Niveaux de hiérarchie ; `[]` = type plat. */
  hierarchy: HierarchyLevel[];
}

/** `true` si le type matérialise des nœuds (série, set…). */
export function isHierarchical(profile: CollectionTypeProfile): boolean {
  return profile.hierarchy.length > 0;
}
