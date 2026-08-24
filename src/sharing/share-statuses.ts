import { ITEM_STATUSES, ItemStatus } from '../items/dto/item-user-data.schema';

/**
 * Ce qu'un partage expose d'une collection : un sous-ensemble **non vide** des statuts d'item.
 *
 * Remplace les portées `all` / `owned` / `wantlist` de S3-S4, qui ne survivent que comme raccourcis
 * d'interface : `all` = les trois statuts, `owned` = `['OWNED']`, `wantlist` = `['WISHLIST']`. Le
 * serveur ne stocke et ne comprend que l'ensemble — ce qui rend exprimables les combinaisons que
 * les portées interdisaient, à commencer par « possédés et désirés, mais pas les ignorés ».
 *
 * Un seul vocabulaire, celui d'`ItemStatus` (S1) : rien à traduire entre l'API, la base et le
 * filtrage.
 */
export type ShareStatus = ItemStatus;

/** Tout exposer. Également la portée implicite d'un propriétaire sur sa propre collection. */
export const ALL_SHARE_STATUSES: readonly ShareStatus[] = ITEM_STATUSES;

/**
 * Dédoublonne et remet dans l'ordre canonique d'`ITEM_STATUSES`.
 *
 * Passer par là avant de stocker et avant de comparer : deux ensembles égaux doivent avoir la même
 * représentation, sans quoi `['WISHLIST','OWNED']` et `['OWNED','WISHLIST']` divergeraient en base
 * pour rien.
 */
export function normalizeStatuses(raw: readonly ShareStatus[]): ShareStatus[] {
  return ITEM_STATUSES.filter((status) => raw.includes(status));
}

/**
 * Statuts d'une entrée de partage, lus depuis la colonne JSON.
 *
 * Tolérant par construction : tout ce qui n'est pas un statut connu est écarté, une valeur abîmée
 * donne l'ensemble vide. L'ensemble vide ne montre rien — c'est le bon sens de la défaillance pour
 * un partage, l'inverse ouvrirait la collection entière sur une ligne corrompue.
 */
export function parseStatuses(value: unknown): ShareStatus[] {
  if (!Array.isArray(value)) return [];
  return normalizeStatuses(
    value.filter((v): v is ShareStatus =>
      ITEM_STATUSES.includes(v as ShareStatus),
    ),
  );
}

/** `true` si l'ensemble couvre tous les statuts : il n'y a alors rien à filtrer. */
export function isAllStatuses(statuses: readonly ShareStatus[]): boolean {
  return ITEM_STATUSES.every((status) => statuses.includes(status));
}

/**
 * Union de plusieurs ensembles.
 *
 * Sert quand un membre détient **plusieurs partages actifs de la même collection** : il voit la
 * réunion de ce que chacun lui accorde, ce qui est exactement ce qu'on lui a accordé. C'est ce que
 * le modèle en ensembles rend enfin exprimable — avec les portées de S4, `owned` et `wantlist`
 * n'étant pas comparables, il fallait en choisir une arbitrairement.
 */
export function unionStatuses(
  sets: readonly (readonly ShareStatus[])[],
): ShareStatus[] {
  return ITEM_STATUSES.filter((status) =>
    sets.some((set) => set.includes(status)),
  );
}
