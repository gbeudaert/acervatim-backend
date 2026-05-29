import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CollectionNode, Prisma } from '@prisma/client';
import {
  SourceEntry,
  SourceRef,
  SourceRefView,
} from '../collections/types/common';
import { getProfile } from '../collections/types/registry';
import { CursorPage, paginate } from '../common/pagination/paginate';
import { SourceSnapshotService } from '../common/sources/source-snapshot.service';
import { UnifiedItem } from '../oauth/providers/types';
import { PrismaService } from '../prisma/prisma.service';
import { AttachNodeSourceDto } from './dto/attach-source.dto';
import { CreateNodeDto } from './dto/create-node.dto';
import { ListNodesQueryDto } from './dto/list-nodes.query';
import { UpdateNodeDto } from './dto/update-node.dto';

type JsonRecord = Record<string, unknown>;

export interface NodeResponse {
  id: string;
  level: string;
  ownedCount: number;
  isWishlist: boolean;
  userData: JsonRecord;
  sources: SourceRefView[];
  [key: string]: unknown; // champs curés de unifiedData (title, author, …)
}

@Injectable()
export class NodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshots: SourceSnapshotService,
  ) {}

  /** 404 si la collection n'existe pas OU appartient à un autre user. */
  private async assertCollectionOwned(
    userId: string,
    collectionId: string,
  ): Promise<{ id: string; type: { code: string } }> {
    const collection = await this.prisma.collection.findFirst({
      where: { id: collectionId, userId },
      select: { id: true, type: { select: { code: true } } },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    return collection;
  }

  private toEntries(value: Prisma.JsonValue): SourceEntry[] {
    return Array.isArray(value) ? (value as unknown as SourceEntry[]) : [];
  }

  private toRefs(value: Prisma.JsonValue): SourceRefView[] {
    return this.toEntries(value).map((e) => ({
      provider: e.provider,
      externalId: e.externalId,
      fetchedAt: e.fetchedAt,
    }));
  }

  private toResponse(node: CollectionNode, ownedCount: number): NodeResponse {
    const unified = (node.unifiedData ?? {}) as JsonRecord;
    return {
      ...unified,
      id: node.id,
      level: node.level,
      ownedCount,
      isWishlist: node.isWishlist,
      userData: (node.userData ?? {}) as JsonRecord,
      sources: this.toRefs(node.sources),
    };
  }

  // ownedCount = nombre d'items rattachés, par nœud (un seul groupBy pour la page).
  private async ownedCounts(
    nodeIds: string[],
  ): Promise<Record<string, number>> {
    if (nodeIds.length === 0) return {};
    const groups = await this.prisma.item.groupBy({
      by: ['nodeId'],
      where: { nodeId: { in: nodeIds } },
      _count: { _all: true },
    });
    return Object.fromEntries(
      groups.map((g) => [g.nodeId as string, g._count._all]),
    );
  }

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

  async create(
    userId: string,
    collectionId: string,
    dto: CreateNodeDto,
  ): Promise<NodeResponse> {
    const collection = await this.assertCollectionOwned(userId, collectionId);
    const profile = getProfile(collection.type.code);
    const level = profile.hierarchy.find((l) => l.key === dto.level);
    if (!level) {
      throw new BadRequestException(
        `level '${dto.level}' is not supported for this collection type`,
      );
    }

    // Dédup : un nœud de cette collection matche déjà la source → idempotent.
    const existingId = await this.findNodeBySource(
      collectionId,
      userId,
      dto.level,
      dto.source,
    );
    if (existingId) {
      return this.findOne(userId, existingId);
    }

    const entry = await this.snapshots.snapshot(dto.source, userId);
    if (entry.rawData === null) {
      throw new BadRequestException(
        `node provider '${dto.source.provider}' has no adapter; cannot enrich node`,
      );
    }
    const unifiedData = level.nodeSchema.parse(
      level.mapSnapshot(entry.rawData as UnifiedItem),
    ) as JsonRecord;

    const node = await this.prisma.collectionNode.create({
      data: {
        collectionId,
        userId,
        level: dto.level,
        unifiedData: unifiedData as Prisma.InputJsonValue,
        sources: [entry] as unknown as Prisma.InputJsonValue,
        isWishlist: dto.isWishlist ?? false,
      },
    });
    return this.toResponse(node, 0);
  }

  async list(
    userId: string,
    collectionId: string,
    query: ListNodesQueryDto,
  ): Promise<CursorPage<NodeResponse>> {
    await this.assertCollectionOwned(userId, collectionId);
    const where: Prisma.CollectionNodeWhereInput = {
      collectionId,
      userId,
      ...(query.level ? { level: query.level } : {}),
    };
    const page = await paginate(
      (take, cursor) =>
        this.prisma.collectionNode.findMany({
          where,
          take,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      query.cursor,
      query.limit,
    );
    const counts = await this.ownedCounts(page.data.map((n) => n.id));
    return {
      ...page,
      data: page.data.map((n) => this.toResponse(n, counts[n.id] ?? 0)),
    };
  }

  /** 404 si le nœud appartient à un autre user. */
  async findOne(userId: string, id: string): Promise<NodeResponse> {
    const node = await this.prisma.collectionNode.findFirst({
      where: { id, userId },
    });
    if (!node) {
      throw new NotFoundException('Node not found');
    }
    const ownedCount = await this.prisma.item.count({ where: { nodeId: id } });
    return this.toResponse(node, ownedCount);
  }

  async getSources(userId: string, id: string): Promise<SourceEntry[]> {
    const node = await this.prisma.collectionNode.findFirst({
      where: { id, userId },
      select: { sources: true },
    });
    if (!node) {
      throw new NotFoundException('Node not found');
    }
    return this.toEntries(node.sources);
  }

  /** Retourne le nœud mis à jour, ou `null` si purgé (isWishlist=false & vide). */
  async update(
    userId: string,
    id: string,
    dto: UpdateNodeDto,
  ): Promise<NodeResponse | null> {
    const node = await this.prisma.collectionNode.findFirst({
      where: { id, userId },
      include: { collection: { select: { type: { select: { code: true } } } } },
    });
    if (!node) {
      throw new NotFoundException('Node not found');
    }

    const ownedCount = await this.prisma.item.count({ where: { nodeId: id } });
    if (dto.isWishlist === false && ownedCount === 0) {
      await this.prisma.collectionNode.delete({ where: { id } });
      return null;
    }

    const data: Prisma.CollectionNodeUpdateInput = {};
    if (dto.unifiedData !== undefined) {
      const profile = getProfile(node.collection.type.code);
      const level = profile.hierarchy.find((l) => l.key === node.level);
      const validated = level
        ? (level.nodeSchema.parse(dto.unifiedData) as JsonRecord)
        : dto.unifiedData;
      data.unifiedData = validated as Prisma.InputJsonValue;
    }
    if (dto.note !== undefined || dto.comment !== undefined) {
      const userData = { ...((node.userData ?? {}) as JsonRecord) };
      if (dto.note !== undefined) userData.note = dto.note;
      if (dto.comment !== undefined) userData.comment = dto.comment;
      data.userData = userData as Prisma.InputJsonValue;
    }
    if (dto.isWishlist !== undefined) {
      data.isWishlist = dto.isWishlist;
    }

    const updated = await this.prisma.collectionNode.update({
      where: { id },
      data,
    });
    return this.toResponse(updated, ownedCount);
  }

  async attachSource(
    userId: string,
    id: string,
    dto: AttachNodeSourceDto,
  ): Promise<NodeResponse> {
    const node = await this.prisma.collectionNode.findFirst({
      where: { id, userId },
    });
    if (!node) {
      throw new NotFoundException('Node not found');
    }
    const entry = await this.snapshots.snapshot(dto, userId);
    const sources = [...this.toEntries(node.sources), entry];
    const updated = await this.prisma.collectionNode.update({
      where: { id },
      data: { sources: sources as unknown as Prisma.InputJsonValue },
    });
    const ownedCount = await this.prisma.item.count({ where: { nodeId: id } });
    return this.toResponse(updated, ownedCount);
  }
}
