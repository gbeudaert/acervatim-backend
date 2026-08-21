import { SetMetadata } from '@nestjs/common';
import { CollectionRefVia } from './collection-access.service';

export const COLLECTION_REF_KEY = 'collectionRef';

export interface CollectionRefMeta {
  via: CollectionRefVia;
  param: string;
}

/**
 * Déclare **d'où** une route tire l'identifiant de sa collection, à l'usage de
 * [CollectionPremiumGuard]. Explicite plutôt que déduit du chemin : une route qui s'ajoute dit ce
 * qu'elle vise, au lieu d'obliger le guard à connaître la table des URLs.
 *
 * @example
 * ＠CollectionRef('collection', 'collectionId')  // GET /collections/:collectionId/items
 * ＠CollectionRef('item', 'id')                  // GET /items/:id
 */
export const CollectionRef = (via: CollectionRefVia, param: string) =>
  SetMetadata<string, CollectionRefMeta>(COLLECTION_REF_KEY, { via, param });
