import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DEFAULT_ITEM_STATUS,
  ITEM_STATUSES,
  resolveItemStatus,
} from '../items/dto/item-user-data.schema';
import { PrismaService } from '../prisma/prisma.service';
import { isAllStatuses, ShareStatus } from './share-statuses';

/** Valeur brute de `userData.status`, telle que stockée (peut être absente, nulle, inconnue). */
const RAW_STATUS = Prisma.sql`JSON_UNQUOTE(JSON_EXTRACT(user_data, '$.status'))`;

/**
 * Miroir SQL **exact** de `resolveItemStatus` (S1) : tout ce qui n'est pas un statut connu — clé
 * absente, `null` JSON, valeur inattendue — vaut `DEFAULT_ITEM_STATUS`. La liste des statuts connus
 * et le défaut viennent du module d'origine, jamais réécrits ici : une seule définition, deux
 * expressions.
 *
 * `JSON_UNQUOTE(JSON_EXTRACT(...))` ressort en `utf8mb4_bin` sur MariaDB, donc la comparaison est
 * exacte et sensible à la casse — précisément la sémantique de `ITEM_STATUSES.includes`. Contrairement
 * au cas `matchingCollectionIds` (contains insensible à la casse), aucun `COLLATE` n'est à forcer.
 */
const EFFECTIVE_STATUS = Prisma.sql`CASE WHEN ${RAW_STATUS} IN (${Prisma.join([
  ...ITEM_STATUSES,
])}) THEN ${RAW_STATUS} ELSE ${DEFAULT_ITEM_STATUS} END`;

/**
 * Pendant TS du prédicat ci-dessus, pour les lectures unitaires : sur un item déjà chargé, un
 * aller-retour SQL pour trancher sa visibilité ne se justifie pas. Les deux formes doivent dire la
 * même chose — c'est ce que vérifie `share-filter.service.spec.ts`.
 */
export function itemVisibleUnderStatuses(
  userData: unknown,
  statuses: readonly ShareStatus[],
): boolean {
  return statuses.includes(resolveItemStatus(userData));
}

/**
 * Traduction d'un jeu de statuts en `where` Prisma, pour les routes de lecture existantes.
 *
 * Les statuts ne viennent **jamais** du client : ils sortent de `CollectionAccess`, résolu
 * serveur-side depuis les entrées de partage. Un membre ne peut pas s'accorder un statut de plus.
 *
 * **Forme retenue : un ensemble d'ids calculé en SQL, injecté dans le `where`.** Un filtre JSON ne
 * s'exprime pas de façon fiable en Prisma sur MariaDB (la clé *absente* casse toute négation), et le
 * patron « SQL brut → `id in/notIn` » est déjà celui de `matchingCollectionIds` et
 * `itemIdsByProvider`. On calcule toujours l'ensemble **minoritaire** attendu : les items masqués
 * quand le statut par défaut est exposé (cas courant, la majorité d'une collection), les items
 * visibles sinon.
 *
 * Limite assumée : sur une collection où cet ensemble est en fait volumineux, la liste d'ids grossit
 * et le filtre JSON n'est pas indexé. Le jour où ça se mesure, la sortie est une colonne générée
 * indexée sur `user_data->'$.status'`, pas un contournement ici.
 */
@Injectable()
export class ShareFilterService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Restriction à appliquer aux items d'une collection, ou `null` si l'ensemble n'en pose aucune
   * (tous les statuts, ou propriétaire). À combiner via `AND` : `where.id` porte d'autres filtres.
   */
  async itemWhere(
    collectionId: string,
    statuses: readonly ShareStatus[],
  ): Promise<Prisma.ItemWhereInput | null> {
    if (isAllStatuses(statuses)) return null;
    if (statuses.includes(DEFAULT_ITEM_STATUS)) {
      const hidden = await this.itemIds(collectionId, this.notIn(statuses));
      return hidden.length === 0 ? null : { id: { notIn: hidden } };
    }
    return { id: { in: await this.itemIds(collectionId, this.in(statuses)) } };
  }

  /**
   * Restriction à appliquer aux nœuds (séries), ou `null` si l'ensemble n'en pose aucune.
   *
   * Un nœud n'existe, pour un membre, que par ses tomes visibles — sauf si `WISHLIST` est exposé :
   * une série marquée désirée sort alors **même sans aucun tome**, c'est tout son objet.
   */
  async nodeWhere(
    collectionId: string,
    statuses: readonly ShareStatus[],
  ): Promise<Prisma.CollectionNodeWhereInput | null> {
    if (isAllStatuses(statuses)) return null;
    const nodeIds = await this.nodeIdsWithItem(collectionId, this.in(statuses));
    if (!statuses.includes('WISHLIST')) {
      return { id: { in: nodeIds } };
    }
    return nodeIds.length === 0
      ? { isWishlist: true }
      : { OR: [{ isWishlist: true }, { id: { in: nodeIds } }] };
  }

  /**
   * Nombre d'items visibles sous cet ensemble.
   *
   * `Collection.itemCount` est dénormalisé sur la collection **entière** : le servir tel quel à un
   * membre afficherait « 240 éléments » sur une vue qui en montre 12. On le recalcule donc pour la
   * vue partagée plutôt que de le masquer — le compte reste utile, il doit juste être le bon.
   */
  async countItems(
    collectionId: string,
    statuses: readonly ShareStatus[],
  ): Promise<number> {
    const scoped = await this.itemWhere(collectionId, statuses);
    return this.prisma.item.count({
      where: { collectionId, ...(scoped ? { AND: [scoped] } : {}) },
    });
  }

  /**
   * Nombre d'items visibles par nœud.
   *
   * Remplace un `groupBy` Prisma : le compte affiché sur une série doit être celui des tomes que le
   * membre voit, sinon une vue « désirés » annonce « 12 tomes » sur une série dont elle n'en montre
   * aucun.
   */
  async countItemsByNode(
    nodeIds: string[],
    statuses: readonly ShareStatus[],
  ): Promise<Record<string, number>> {
    if (nodeIds.length === 0) return {};
    const restriction = isAllStatuses(statuses)
      ? Prisma.empty
      : Prisma.sql`AND ${this.in(statuses)}`;
    const rows = await this.prisma.$queryRaw<{ nodeId: string; n: bigint }[]>`
      SELECT node_id AS nodeId, COUNT(*) AS n FROM items
      WHERE node_id IN (${Prisma.join(nodeIds)})
        ${restriction}
      GROUP BY node_id
    `;
    return Object.fromEntries(rows.map((r) => [r.nodeId, Number(r.n)]));
  }

  /** « Cet item est visible ». */
  private in(statuses: readonly ShareStatus[]): Prisma.Sql {
    // Un ensemble vide ne doit rien montrer : `IN ()` étant invalide en SQL, on écrit un faux franc.
    if (statuses.length === 0) return Prisma.sql`1 = 0`;
    return Prisma.sql`${EFFECTIVE_STATUS} IN (${Prisma.join([...statuses])})`;
  }

  /** Complément exact du précédent. */
  private notIn(statuses: readonly ShareStatus[]): Prisma.Sql {
    if (statuses.length === 0) return Prisma.sql`1 = 1`;
    return Prisma.sql`${EFFECTIVE_STATUS} NOT IN (${Prisma.join([...statuses])})`;
  }

  private async itemIds(
    collectionId: string,
    predicate: Prisma.Sql,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM items
      WHERE collection_id = ${collectionId}
        AND ${predicate}
    `;
    return rows.map((r) => r.id);
  }

  private async nodeIdsWithItem(
    collectionId: string,
    predicate: Prisma.Sql,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ nodeId: string }[]>`
      SELECT DISTINCT node_id AS nodeId FROM items
      WHERE collection_id = ${collectionId}
        AND node_id IS NOT NULL
        AND ${predicate}
    `;
    return rows.map((r) => r.nodeId);
  }
}
