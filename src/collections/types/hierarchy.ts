import { CollectionTypeProfile } from './common';

export interface HierarchySummaryEntry {
  key: string;
  label: string;
  count: number;
}

/**
 * Résumé `hierarchy[]` exposé par `GET /collections/:id` : un item par niveau
 * du profil, avec le nombre de nœuds matérialisés. Type plat → `[]`.
 */
export function summarizeHierarchy(
  profile: CollectionTypeProfile,
  countsByLevel: Record<string, number>,
): HierarchySummaryEntry[] {
  return profile.hierarchy.map((level) => ({
    key: level.key,
    label: level.label,
    count: countsByLevel[level.key] ?? 0,
  }));
}
