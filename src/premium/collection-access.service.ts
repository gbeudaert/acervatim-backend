import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALL_SHARE_STATUSES,
  parseStatuses,
  ShareStatus,
  unionStatuses,
} from '../sharing/share-statuses';

/**
 * Entité par laquelle une route désigne sa collection. `collection` = le paramètre EST l'id de la
 * collection ; `item`/`node` = il faut remonter à la collection parente.
 */
export type CollectionRefVia = 'collection' | 'item' | 'node';

/** Rôle du requérant sur une collection. */
export type CollectionRole = 'owner' | 'shared';

interface AccessBase {
  collectionId: string;
  /** Propriétaire de la collection — c'est **son** statut premium qui conditionne la lecture. */
  ownerUserId: string;
}

export interface OwnerAccess extends AccessBase {
  role: 'owner';
}

export interface SharedAccess extends AccessBase {
  role: 'shared';
  /**
   * Statuts que les partages actifs exposent de cette collection, réunis. Résolus serveur-side,
   * jamais fournis par le client.
   */
  statuses: ShareStatus[];
}

export type CollectionAccess = OwnerAccess | SharedAccess;

/** Statuts effectivement lisibles : le propriétaire voit toujours 100 % de sa collection. */
export function accessStatuses(access: CollectionAccess): ShareStatus[] {
  return access.role === 'shared' ? access.statuses : [...ALL_SHARE_STATUSES];
}

/**
 * Résolution unique « quelle collection cette requête vise-t-elle, et à quel titre ».
 *
 * Centralisé plutôt que dispersé dans chaque route : `collections`, `items` et `nodes` lisent tous
 * la même règle, et une route qui s'ajoute déclare simplement d'où vient son identifiant
 * (cf. `@CollectionRef`).
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
   * Rôle du requérant sur la collection, `null` s'il n'y a aucun accès (collection inexistante,
   * appartenant à quelqu'un d'autre, ou partage/adhésion révoqués — indistinguables volontairement,
   * cf. la convention 404 des services : on ne confirme jamais l'existence d'une ressource d'autrui).
   *
   * `expiresAt` n'entre **pas** dans le filtre : il borne l'usage du *code*, pas l'adhésion déjà
   * acquise (invariant posé en S3, cf. le commentaire du modèle Prisma et `listReceived`). Un
   * partage expiré cesse d'être rejoignable ; ceux qui l'ont rejoint continuent de lire jusqu'à
   * révocation. Faire l'inverse ici ferait mentir `GET /v1/shares/received`, qui les liste encore.
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

    // Les entrées qui exposent CETTE collection, parmi les partages vivants que ce membre a
    // rejoints. Un partage porte N collections : c'est l'entrée, pas le partage, qui dit ce qu'on
    // voit d'ici.
    const entries = await this.prisma.collectionShareEntry.findMany({
      where: {
        collectionId,
        share: {
          revokedAt: null,
          members: { some: { memberUserId: userId, revokedAt: null } },
        },
      },
      select: { statuses: true },
    });
    if (entries.length === 0) return null;

    // Plusieurs partages actifs de la même collection : le membre voit la réunion de ce que chacun
    // lui accorde — ni plus, ni moins.
    const statuses = unionStatuses(
      entries.map((entry) => parseStatuses(entry.statuses)),
    );
    // Ensemble vide (ligne abîmée) : pas d'accès du tout plutôt qu'un accès qui ne montre rien.
    if (statuses.length === 0) return null;

    return {
      collectionId: collection.id,
      ownerUserId: collection.userId,
      role: 'shared',
      statuses,
    };
  }
}
