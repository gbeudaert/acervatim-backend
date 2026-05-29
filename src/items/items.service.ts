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
import { QuotaService } from '../common/quota/quota.service';
import { SourceSnapshotService } from '../common/sources/source-snapshot.service';
import { UnifiedItem } from '../oauth/providers/types';
import { PrismaService } from '../prisma/prisma.service';
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
  sources: SourceRefView[];
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: QuotaService,
    private readonly snapshots: SourceSnapshotService,
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

  private toCurated(item: Item): CuratedItem {
    return {
      id: item.id,
      collectionId: item.collectionId,
      nodeId: item.nodeId,
      volume: item.volume,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      unifiedData: (item.unifiedData ?? {}) as JsonRecord,
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

    if (hierarchical) {
      if (!dto.node || dto.volume === undefined) {
        throw new BadRequestException(
          'node and volume are required for this collection type',
        );
      }
    } else if (dto.node || dto.volume !== undefined) {
      throw new BadRequestException(
        'node/volume are not allowed for a flat collection type',
      );
    }

    const unifiedData = this.validateUnified(typeCode, dto.unifiedData);

    // Résolution du nœud (hors transaction : peut déclencher un fetch réseau).
    let existingNodeId: string | null = null;
    let nodeCreate: {
      level: string;
      unifiedData: JsonRecord;
      sources: SourceEntry[];
    } | null = null;
    if (hierarchical && dto.node) {
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
          throw new BadRequestException(
            `node provider '${dto.node.provider}' has no adapter; cannot enrich series node`,
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
      // Quota + create (+ upsert nœud) + increment dans la même tx (cf. SEC-004).
      const item = await this.prisma.$transaction(async (tx) => {
        await this.quota.assertCanCreateItem(userId, tx);
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

  async list(
    userId: string,
    collectionId: string,
    query: ListItemsQueryDto,
  ): Promise<CursorPage<LightItem>> {
    const collection = await this.assertCollectionOwned(userId, collectionId);
    const profile = getProfile(collection.type.code);

    const where: Prisma.ItemWhereInput = { collectionId, userId };
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
        userId,
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
    node: { unifiedData: Prisma.JsonValue } | null;
  }): ItemProjectionRow {
    return {
      id: row.id,
      nodeId: row.nodeId,
      volume: row.volume,
      unifiedData: (row.unifiedData ?? {}) as JsonRecord,
      node: row.node
        ? { unifiedData: (row.node.unifiedData ?? {}) as JsonRecord }
        : null,
    };
  }

  /** 404 si l'item appartient à un autre user (scope via `userId` dénormalisé). */
  async findOne(userId: string, id: string): Promise<CuratedItem> {
    const item = await this.prisma.item.findFirst({ where: { id, userId } });
    if (!item) {
      throw new NotFoundException('Item not found');
    }
    return this.toCurated(item);
  }

  /** Snapshots bruts d'un item (pour l'UI de comparaison). */
  async getSources(userId: string, id: string): Promise<SourceEntry[]> {
    const item = await this.prisma.item.findFirst({
      where: { id, userId },
      select: { sources: true },
    });
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
    const unifiedData = this.validateUnified(
      item.collection.type.code,
      dto.unifiedData,
    );
    const updated = await this.prisma.item.update({
      where: { id },
      data: { unifiedData: unifiedData as Prisma.InputJsonValue },
    });
    return this.toCurated(updated);
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
        const remaining = await tx.item.count({
          where: { nodeId: item.nodeId },
        });
        if (remaining === 0) {
          const node = await tx.collectionNode.findUnique({
            where: { id: item.nodeId },
            select: { isWishlist: true },
          });
          if (node && !node.isWishlist) {
            await tx.collectionNode.delete({ where: { id: item.nodeId } });
          }
        }
      }
    });
  }
}
