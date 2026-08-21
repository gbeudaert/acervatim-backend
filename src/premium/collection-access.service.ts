import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Entité par laquelle une route désigne sa collection. `collection` = le paramètre EST l'id de la
 * collection ; `item`/`node` = il faut remonter à la collection parente.
 */
export type CollectionRefVia = 'collection' | 'item' | 'node';

/**
 * Rôle du requérant sur une collection.
 *
 * **Point d'extension de S4** : le partage ajoutera `'shared'` (+ la portée `scope`) ici et dans
 * [CollectionAccessService.resolveAccess]. Tant qu'il n'existe pas, seul le propriétaire a un rôle.
 */
export type CollectionRole = 'owner';

export interface CollectionAccess {
  collectionId: string;
  /** Propriétaire de la collection — c'est **son** statut premium qui conditionne la lecture. */
  ownerUserId: string;
  role: CollectionRole;
}

/**
 * Résolution unique « quelle collection cette requête vise-t-elle, et à quel titre ».
 *
 * Centralisé plutôt que dispersé dans chaque route : S4 n'aura qu'un seul endroit à étendre pour
 * faire exister le rôle `shared`, et le jour où une route s'ajoute, elle déclare simplement d'où
 * vient son identifiant (cf. `@CollectionRef`).
 */
@Injectable()
export class CollectionAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Id de la collection visée, ou `null` si la ressource n'existe pas. */
  async resolveCollectionId(
    via: CollectionRefVia,
    id: string,
  ): Promise<string | null> {
    if (via === 'collection') return id;
    if (via === 'item') {
      const item = await this.prisma.item.findUnique({
        where: { id },
        select: { collectionId: true },
      });
      return item?.collectionId ?? null;
    }
    const node = await this.prisma.collectionNode.findUnique({
      where: { id },
      select: { collectionId: true },
    });
    return node?.collectionId ?? null;
  }

  /**
   * Rôle du requérant sur la collection, `null` s'il n'y a aucun accès (collection inexistante ou
   * appartenant à quelqu'un d'autre — indistinguables volontairement, cf. la convention 404 des
   * services : on ne confirme jamais l'existence d'une ressource d'autrui).
   */
  async resolveAccess(
    userId: string,
    collectionId: string,
  ): Promise<CollectionAccess | null> {
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { id: true, userId: true },
    });
    if (!collection) return null;
    if (collection.userId === userId) {
      return {
        collectionId: collection.id,
        ownerUserId: collection.userId,
        role: 'owner',
      };
    }
    // S4 : chercher ici un CollectionShareMember actif → { role: 'shared', scope }.
    return null;
  }
}
