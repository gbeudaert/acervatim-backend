import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Item, Prisma } from '@prisma/client';
import { ZodValidationException } from 'nestjs-zod';
import {
  ItemProjectionRow,
  LightItem,
  SourceEntry,
  SourceRef,
  SourceRefView,
} from '../collections/types/common';
import { getProfile } from '../collections/types/registry';
import { CursorPage, paginate } from '../common/pagination/paginate';
import { LimitsService } from '../common/limits/limits.service';
import { SourceSnapshotService } from '../common/sources/source-snapshot.service';
import { UnifiedItem } from '../oauth/providers/types';
import {
  accessStatuses,
  CollectionAccess,
} from '../premium/collection-access.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  itemVisibleUnderStatuses,
  ShareFilterService,
} from '../sharing/share-filter.service';
import { sharedItemUserData } from '../sharing/shared-user-data';
import { CreateItemDto } from './dto/create-item.dto';
import { ListItemsQueryDto } from './dto/list-items.query';
import { UpdateItemDto } from './dto/update-item.dto';

type JsonRecord = Record<string, unknown>;

interface OwnedCollection {
  id: string;
  type: { code: string };
}

// Item curé renvoyé en détail (sources = réfs sans rawData).
export interface CuratedItem {
  id: string;
  collectionId: string;
  nodeId: string | null;
  volume: number | null;
  createdAt: Date;
  updatedAt: Date;
  unifiedData: JsonRecord;
  userData: JsonRecord;
  sources: SourceRefView[];
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: LimitsService,
    private readonly snapshots: SourceSnapshotService,
    private readonly shareFilter: ShareFilterService,
  ) {}

  /** 404 si la collection n'existe pas OU appartient à un autre user (pas de leak). */
  private async assertCollectionOwned(
    userId: string,
    collectionId: string,
  ): Promise<OwnedCollection> {
    const collection = await this.prisma.collection.findFirst({
      where: { id: collectionId, userId },
      select: { id: true, type: { select: { code: true } } },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    return collection;
  }

  // Valide `unifiedData` via le profil du type (discriminant `type` forcé).
  private validateUnified(typeCode: string, raw: JsonRecord): JsonRecord {
    const profile = getProfile(typeCode);
    const result = profile.itemSchema.safeParse({ ...raw, type: typeCode });
    if (!result.success) {
      throw new ZodValidationException(result.error);
    }
    return result.data as JsonRecord;
  }

  // id du nœud de cette collection dont sources[] matche (provider, externalId), ou null.
  private async findNodeBySource(
    collectionId: string,
    userId: string,
    level: string,
    ref: SourceRef,
  ): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM collection_nodes
      WHERE collection_id = ${collectionId}
        AND user_id = ${userId}
        AND level = ${level}
        AND JSON_CONTAINS(sources, JSON_OBJECT('provider', ${ref.provider}, 'externalId', ${ref.externalId}))
      LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }

  /**
   * Vérifie que `nodeId` désigne bien un nœud de **cette** collection et de ce propriétaire.
   *
   * 404 et non 400 : un nœud d'un autre utilisateur doit être indiscernable d'un nœud inexistant,
   * sinon un balayage d'ids devient un oracle d'existence (même règle qu'en lecture).
   */
  private async assertNodeOwned(
    userId: string,
    collectionId: string,
    nodeId: string,
  ): Promise<string> {
    const node = await this.prisma.collectionNode.findFirst({
      where: { id: nodeId, userId, collectionId },
      select: { id: true },
    });
    if (!node) {
      throw new NotFoundException('Node not found');
    }
    return node.id;
  }

  // ids des items de la collection dont sources[] contient l'un des providers (OR).
  private async itemIdsByProvider(
    userId: string,
    collectionId: string,
    providers: string[],
  ): Promise<string[]> {
    const clauses = providers.map(
      (p) => Prisma.sql`JSON_CONTAINS(sources, JSON_OBJECT('provider', ${p}))`,
    );
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM items
      WHERE user_id = ${userId}
        AND collection_id = ${collectionId}
        AND (${Prisma.join(clauses, ' OR ')})
    `;
    return rows.map((r) => r.id);
  }

  private toEntries(value: Prisma.JsonValue): SourceEntry[] {
    return Array.isArray(value) ? (value as unknown as SourceEntry[]) : [];
  }

  /**
   * `role` conditionne le `userData` rendu : un membre n'en voit que la part partageable
   * (cf. `sharedItemUserData`). Le reste du DTO est identique — même forme de réponse pour le
   * propriétaire et pour le membre, c'est ce qui permet à l'app de réutiliser ses écrans.
   */
  private toCurated(
    item: Item,
    role: 'owner' | 'shared' = 'owner',
  ): CuratedItem {
    const userData = (item.userData ?? {}) as JsonRecord;
    return {
      id: item.id,
      collectionId: item.collectionId,
      nodeId: item.nodeId,
      volume: item.volume,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      unifiedData: (item.unifiedData ?? {}) as JsonRecord,
      userData: role === 'shared' ? sharedItemUserData(userData) : userData,
      sources: this.toEntries(item.sources).map((e) => ({
        provider: e.provider,
        externalId: e.externalId,
        fetchedAt: e.fetchedAt,
      })),
    };
  }

  async create(
    userId: string,
    collectionId: string,
    dto: CreateItemDto,
  ): Promise<CuratedItem> {
    const collection = await this.assertCollectionOwned(userId, collectionId);
    const typeCode = collection.type.code;
    const profile = getProfile(typeCode);
    const hierarchical = profile.hierarchy.length > 0;

    if (!hierarchical && (dto.node || dto.nodeId || dto.volume !== undefined)) {
      throw new BadRequestException(
        'node/nodeId/volume are not allowed for a flat collection type',
      );
    }
    // Sur un type hiérarchique, ni la série ni le n° de tome ne sont exigés : supprimer une série
    // laisse ses tomes orphelins (le modèle app les conserve), et un hors-série n'a pas de numéro.
    // Les refuser ferait de la synchronisation une perte de données, pas un miroir.

    const unifiedData = this.validateUnified(typeCode, dto.unifiedData);

    // Résolution du nœud (hors transaction : peut déclencher un fetch réseau).
    let existingNodeId: string | null = null;
    let nodeCreate: {
      level: string;
      unifiedData: JsonRecord;
      sources: SourceEntry[];
    } | null = null;
    if (hierarchical && dto.nodeId) {
      existingNodeId = await this.assertNodeOwned(
        userId,
        collectionId,
        dto.nodeId,
      );
    } else if (hierarchical && dto.node) {
      const level = profile.hierarchy[0];
      existingNodeId = await this.findNodeBySource(
        collectionId,
        userId,
        level.key,
        dto.node,
      );
      if (!existingNodeId) {
        const entry = await this.snapshots.snapshot(dto.node, userId);
        if (entry.rawData === null) {
          // Sans adapter, rien ici ne sait de quoi la série est faite. La créer d'abord
          // (POST /collections/:id/nodes avec son `unifiedData`) puis passer `nodeId` est le
          // chemin prévu — un item ne porte pas la vérité curée de son parent.
          throw new BadRequestException(
            `node provider '${dto.node.provider}' has no adapter; create the node first and pass 'nodeId'`,
          );
        }
        const nodeUnified = level.nodeSchema.parse(
          level.mapSnapshot(entry.rawData as UnifiedItem),
        ) as JsonRecord;
        nodeCreate = {
          level: level.key,
          unifiedData: nodeUnified,
          sources: [entry],
        };
      }
    }

    // Snapshots des sources propres à l'item (hors transaction).
    const itemSources: SourceEntry[] = [];
    for (const ref of dto.sources ?? []) {
      itemSources.push(await this.snapshots.snapshot(ref, userId));
    }

    try {
      // Plafond technique + create (+ upsert nœud) + increment dans la même tx (cf. SEC-004).
      const item = await this.prisma.$transaction(async (tx) => {
        await this.limits.assertCanCreateItem(userId, tx);
        let nodeId = existingNodeId;
        if (nodeCreate) {
          const node = await tx.collectionNode.create({
            data: {
              collectionId,
              userId,
              level: nodeCreate.level,
              unifiedData: nodeCreate.unifiedData as Prisma.InputJsonValue,
              sources: nodeCreate.sources as unknown as Prisma.InputJsonValue,
            },
            select: { id: true },
          });
          nodeId = node.id;
        }
        const created = await tx.item.create({
          data: {
            collectionId,
            userId,
            nodeId,
            volume: dto.volume ?? null,
            unifiedData: unifiedData as Prisma.InputJsonValue,
            userData: (dto.userData ?? {}) as Prisma.InputJsonValue,
            sources: itemSources as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.collection.update({
          where: { id: collectionId },
          data: { itemCount: { increment: 1 } },
        });
        return created;
      });
      return this.toCurated(item);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('item déjà ajouté (série + volume)');
      }
      throw err;
    }
  }

  /**
   * Liste des items visibles pour ce requérant.
   *
   * `access` remplace le `userId` d'avant S4 : la collection reste scopée sur son **propriétaire**
   * (`ownerUserId`), et les statuts du partage — jamais reçus du client — restreignent le `where`.
   * Un propriétaire les a tous : sa propre lecture est inchangée.
   */
  async list(
    access: CollectionAccess,
    query: ListItemsQueryDto,
  ): Promise<CursorPage<LightItem>> {
    const collectionId = access.collectionId;
    const typeCode = await this.collectionTypeCode(collectionId);
    const profile = getProfile(typeCode);

    const where: Prisma.ItemWhereInput = {
      collectionId,
      userId: access.ownerUserId,
    };
    if (query.nodeId) {
      if (profile.hierarchy.length === 0) {
        throw new BadRequestException(
          'nodeId filter is not allowed on a flat collection type',
        );
      }
      where.nodeId = query.nodeId;
    }
    if (query.provider) {
      const ids = await this.itemIdsByProvider(
        access.ownerUserId,
        collectionId,
        query.provider.in,
      );
      if (ids.length === 0) {
        return {
          data: [],
          meta: { pagination: { nextCursor: null, limit: query.limit } },
        };
      }
      where.id = { in: ids };
    }
    // `AND` et non `where.id` : le filtre par provider occupe déjà `id`.
    const scoped = await this.shareFilter.itemWhere(
      collectionId,
      accessStatuses(access),
    );
    if (scoped) {
      where.AND = [scoped];
    }

    const page = await paginate(
      (take, cursor) =>
        this.prisma.item.findMany({
          where,
          take,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            nodeId: true,
            volume: true,
            unifiedData: true,
            userData: true,
            node: { select: { unifiedData: true } },
          },
        }),
      query.cursor,
      query.limit,
    );

    return {
      ...page,
      data: page.data.map((row) =>
        profile.toListProjection(this.toProjectionRow(row)),
      ),
    };
  }

  private toProjectionRow(row: {
    id: string;
    nodeId: string | null;
    volume: number | null;
    unifiedData: Prisma.JsonValue;
    userData: Prisma.JsonValue;
    node: { unifiedData: Prisma.JsonValue } | null;
  }): ItemProjectionRow {
    return {
      id: row.id,
      nodeId: row.nodeId,
      volume: row.volume,
      unifiedData: (row.unifiedData ?? {}) as JsonRecord,
      userData: (row.userData ?? {}) as JsonRecord,
      node: row.node
        ? { unifiedData: (row.node.unifiedData ?? {}) as JsonRecord }
        : null,
    };
  }

  /** Type de la collection visée. Son existence est déjà acquise (résolue par le guard). */
  private async collectionTypeCode(collectionId: string): Promise<string> {
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { type: { select: { code: true } } },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    return collection.type.code;
  }

  /**
   * Item chargé sous l'angle du requérant, ou `null` s'il est hors de sa portée.
   *
   * Hors des statuts exposés renvoie la **même** absence qu'un item inexistant : sans ça, un membre
   * à qui l'on ne partage que les possédés déduirait l'existence d'un désiré en balayant des ids.
   */
  private async visibleItem(
    access: CollectionAccess,
    id: string,
  ): Promise<Item | null> {
    const item = await this.prisma.item.findFirst({
      where: {
        id,
        collectionId: access.collectionId,
        userId: access.ownerUserId,
      },
    });
    if (!item) return null;
    // Sur une lecture unitaire, le prédicat TS suffit : pas d'aller-retour SQL pour un seul item.
    return itemVisibleUnderStatuses(item.userData, accessStatuses(access))
      ? item
      : null;
  }

  /** 404 si l'item n'existe pas, sort de la collection visée, ou tombe hors des statuts exposés. */
  async findOne(access: CollectionAccess, id: string): Promise<CuratedItem> {
    const item = await this.visibleItem(access, id);
    if (!item) {
      throw new NotFoundException('Item not found');
    }
    return this.toCurated(item, access.role);
  }

  /**
   * Snapshots bruts d'un item (pour l'UI de comparaison).
   *
   * Rendus tels quels à un membre : `sources[].rawData` est la réponse d'un catalogue public
   * (BnF, Google Books, MangaDex, Discogs, MAL, TMDB) sur une œuvre, jamais une donnée de compte —
   * les adapters ne récupèrent que des fiches d'œuvres (`fetchDetails(id)`).
   */
  async getSources(
    access: CollectionAccess,
    id: string,
  ): Promise<SourceEntry[]> {
    const item = await this.visibleItem(access, id);
    if (!item) {
      throw new NotFoundException('Item not found');
    }
    return this.toEntries(item.sources);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateItemDto,
  ): Promise<CuratedItem> {
    const item = await this.prisma.item.findFirst({
      where: { id, userId },
      include: { collection: { select: { type: { select: { code: true } } } } },
    });
    if (!item) {
      throw new NotFoundException('Item not found');
    }
    const data: Prisma.ItemUpdateInput = {};
    if (dto.unifiedData !== undefined) {
      // `unifiedData` est remplacé en bloc (re-validé par le profil du type), sauf ce que le
      // profil décide de préserver face à l'existant (cf. `reconcileOnUpdate`).
      const typeCode = item.collection.type.code;
      const validated = this.validateUnified(typeCode, dto.unifiedData);
      const profile = getProfile(typeCode);
      data.unifiedData = (
        profile.reconcileOnUpdate
          ? profile.reconcileOnUpdate(
              validated,
              (item.unifiedData ?? {}) as JsonRecord,
            )
          : validated
      ) as Prisma.InputJsonValue;
    }
    if (dto.userData !== undefined) {
      // `userData` est mergé (PATCH partiel) sur l'existant.
      const merged = {
        ...((item.userData ?? {}) as JsonRecord),
        ...dto.userData,
      };
      data.userData = merged as Prisma.InputJsonValue;
    }
    // Rattachement : mêmes règles qu'à la création — interdit sur un type plat, et un `nodeId`
    // hors de la collection (ou d'un autre compte) est un 404, pas un 400.
    const structural = dto.nodeId !== undefined || dto.volume !== undefined;
    if (structural) {
      const profile = getProfile(item.collection.type.code);
      if (profile.hierarchy.length === 0) {
        throw new BadRequestException(
          'nodeId/volume are not allowed for a flat collection type',
        );
      }
      if (dto.nodeId !== undefined) {
        data.node = dto.nodeId
          ? {
              connect: {
                id: await this.assertNodeOwned(
                  userId,
                  item.collectionId,
                  dto.nodeId,
                ),
              },
            }
          : { disconnect: true };
      }
      if (dto.volume !== undefined) {
        data.volume = dto.volume;
      }
    }

    const previousNodeId = item.nodeId;
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.item.update({ where: { id }, data });
        // Le tome quitte sa série : celle-ci peut devenir vide, et une série vide non désirée
        // n'a plus de raison d'exister (même purge qu'à la suppression d'un tome).
        if (previousNodeId && previousNodeId !== row.nodeId) {
          await this.purgeNodeIfEmpty(tx, previousNodeId);
        }
        return row;
      });
      return this.toCurated(updated);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('item déjà ajouté (série + volume)');
      }
      throw err;
    }
  }

  /** Supprime un nœud devenu vide et non désiré (dernier tome parti ou supprimé). */
  private async purgeNodeIfEmpty(
    tx: Prisma.TransactionClient,
    nodeId: string,
  ): Promise<void> {
    const remaining = await tx.item.count({ where: { nodeId } });
    if (remaining > 0) return;
    const node = await tx.collectionNode.findUnique({
      where: { id: nodeId },
      select: { isWishlist: true },
    });
    if (node && !node.isWishlist) {
      await tx.collectionNode.delete({ where: { id: nodeId } });
    }
  }

  async attachSource(
    userId: string,
    id: string,
    dto: SourceRef,
  ): Promise<CuratedItem> {
    const item = await this.prisma.item.findFirst({ where: { id, userId } });
    if (!item) {
      throw new NotFoundException('Item not found');
    }
    const entry = await this.snapshots.snapshot(dto, userId);
    const sources = [...this.toEntries(item.sources), entry];
    const updated = await this.prisma.item.update({
      where: { id },
      data: { sources: sources as unknown as Prisma.InputJsonValue },
    });
    return this.toCurated(updated);
  }

  async remove(userId: string, id: string): Promise<void> {
    const item = await this.prisma.item.findFirst({
      where: { id, userId },
      select: { id: true, collectionId: true, nodeId: true },
    });
    if (!item) {
      throw new NotFoundException('Item not found');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.item.delete({ where: { id } });
      await tx.collection.update({
        where: { id: item.collectionId },
        data: { itemCount: { decrement: 1 } },
      });
      // Purge du nœud devenu vide et non-wishlist (dernier tome supprimé).
      if (item.nodeId) {
        await this.purgeNodeIfEmpty(tx, item.nodeId);
      }
    });
  }
}
