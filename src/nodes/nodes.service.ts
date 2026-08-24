import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CollectionNode, Prisma } from '@prisma/client';
import { ZodValidationException } from 'nestjs-zod';
import {
  HierarchyLevel,
  SourceEntry,
  SourceRef,
  SourceRefView,
} from '../collections/types/common';
import { getProfile } from '../collections/types/registry';
import { LimitsService } from '../common/limits/limits.service';
import { CursorPage, paginate } from '../common/pagination/paginate';
import { SourceSnapshotService } from '../common/sources/source-snapshot.service';
import { UnifiedItem } from '../oauth/providers/types';
import {
  accessStatuses,
  CollectionAccess,
} from '../premium/collection-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShareFilterService } from '../sharing/share-filter.service';
import { isAllStatuses } from '../sharing/share-statuses';
import { sharedNodeUserData } from '../sharing/shared-user-data';
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
    private readonly limits: LimitsService,
    private readonly snapshots: SourceSnapshotService,
    private readonly shareFilter: ShareFilterService,
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

  /**
   * `ownedCount` compte les tomes **visibles par le requérant**, pas les tomes absolus : annoncer
   * « 12 tomes » sur une série dont un partage « désirés » n'en montre aucun serait un compte faux.
   * `role` réduit par ailleurs le `userData` à sa part partageable.
   */
  private toResponse(
    node: CollectionNode,
    ownedCount: number,
    role: 'owner' | 'shared' = 'owner',
  ): NodeResponse {
    const unified = (node.unifiedData ?? {}) as JsonRecord;
    const userData = (node.userData ?? {}) as JsonRecord;
    return {
      ...unified,
      id: node.id,
      level: node.level,
      ownedCount,
      isWishlist: node.isWishlist,
      userData: role === 'shared' ? sharedNodeUserData(userData) : userData,
      sources: this.toRefs(node.sources),
    };
  }

  /** Accès d'un propriétaire sur sa propre collection (chemins d'écriture, portée `all`). */
  private ownerAccess(userId: string, collectionId: string): CollectionAccess {
    return { collectionId, ownerUserId: userId, role: 'owner' };
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

  /**
   * Valide un `unifiedData` **venu du client** contre le schéma du niveau.
   *
   * `safeParse` + [ZodValidationException] et non `.parse()` : une `ZodError` nue ne serait pas
   * reconnue par le filtre RFC 9457 et sortirait en 500 alors que la faute est au corps envoyé.
   */
  private validateNodeUnified(
    level: HierarchyLevel,
    raw: JsonRecord,
  ): JsonRecord {
    const result = level.nodeSchema.safeParse(raw);
    if (!result.success) {
      throw new ZodValidationException(result.error);
    }
    return result.data as JsonRecord;
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

    // Dédup : un nœud de cette collection matche déjà la source → idempotent. Sans `source`
    // (saisie manuelle) il n'y a rien sur quoi dédupliquer : le client garde l'id rendu et
    // repasse ensuite par PATCH, comme il le fait pour une collection.
    if (dto.source) {
      const existingId = await this.findNodeBySource(
        collectionId,
        userId,
        dto.level,
        dto.source,
      );
      if (existingId) {
        return this.findOne(this.ownerAccess(userId, collectionId), existingId);
      }
    }

    const entry = dto.source
      ? await this.snapshots.snapshot(dto.source, userId)
      : null;
    const unifiedData = this.resolveUnified(level, dto, entry);

    const node = await this.prisma.$transaction(async (tx) => {
      await this.limits.assertCanCreateNode(userId, tx);
      return tx.collectionNode.create({
        data: {
          collectionId,
          userId,
          level: dto.level,
          unifiedData: unifiedData as Prisma.InputJsonValue,
          sources: (entry ? [entry] : []) as unknown as Prisma.InputJsonValue,
          isWishlist: dto.isWishlist ?? false,
        },
      });
    });
    return this.toResponse(node, 0);
  }

  /**
   * Vérité curée du nœud à créer.
   *
   * Le `unifiedData` du client l'emporte quand il est fourni : c'est ce que l'utilisateur voit
   * dans son app, et le seul contenu disponible pour une série saisie à la main. À défaut, on la
   * dérive du snapshot provider. Reste le cas sans issue — une référence vers un provider sans
   * adapter (bnf, mangadex, isbn…) et aucun `unifiedData` : rien ne décrit le nœud, c'est un 400.
   */
  private resolveUnified(
    level: HierarchyLevel,
    dto: CreateNodeDto,
    entry: SourceEntry | null,
  ): JsonRecord {
    if (dto.unifiedData) {
      return this.validateNodeUnified(level, dto.unifiedData as JsonRecord);
    }
    if (entry?.rawData) {
      return level.nodeSchema.parse(
        level.mapSnapshot(entry.rawData as UnifiedItem),
      ) as JsonRecord;
    }
    throw new BadRequestException(
      entry
        ? `node provider '${entry.provider}' has no adapter; send 'unifiedData' to describe the node`
        : "'source' or 'unifiedData' is required",
    );
  }

  /**
   * Liste des nœuds visibles pour ce requérant.
   *
   * `access` remplace le `userId` d'avant S4 : les nœuds restent scopés sur le **propriétaire** de
   * la collection, et les statuts du partage — jamais reçus du client — restreignent le `where`.
   * Un propriétaire les a tous : sa propre lecture est inchangée.
   */
  async list(
    access: CollectionAccess,
    query: ListNodesQueryDto,
  ): Promise<CursorPage<NodeResponse>> {
    const statuses = accessStatuses(access);
    const where: Prisma.CollectionNodeWhereInput = {
      collectionId: access.collectionId,
      userId: access.ownerUserId,
      ...(query.level ? { level: query.level } : {}),
    };
    const scoped = await this.shareFilter.nodeWhere(
      access.collectionId,
      statuses,
    );
    if (scoped) {
      where.AND = [scoped];
    }
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
    const counts = await this.shareFilter.countItemsByNode(
      page.data.map((n) => n.id),
      statuses,
    );
    return {
      ...page,
      data: page.data.map((n) =>
        this.toResponse(n, counts[n.id] ?? 0, access.role),
      ),
    };
  }

  /**
   * Nœud chargé sous l'angle du requérant, ou `null` s'il est hors de ce qui lui est exposé — même
   * absence qu'un nœud inexistant, pour ne pas transformer un balayage d'ids en oracle d'existence.
   *
   * Pour un membre, un nœud n'existe que par ses tomes visibles. Seule exception : quand `WISHLIST`
   * est exposé, une série marquée désirée sort **même sans aucun tome** — c'est tout son objet.
   */
  private async visibleNode(
    access: CollectionAccess,
    id: string,
  ): Promise<{ node: CollectionNode; ownedCount: number } | null> {
    const node = await this.prisma.collectionNode.findFirst({
      where: {
        id,
        collectionId: access.collectionId,
        userId: access.ownerUserId,
      },
    });
    if (!node) return null;
    const statuses = accessStatuses(access);
    const counts = await this.shareFilter.countItemsByNode([id], statuses);
    const ownedCount = counts[id] ?? 0;
    // Miroir exact de `ShareFilterService.nodeWhere` : tout est visible quand rien n'est filtré
    // (propriétaire, ou partage exposant les trois statuts), y compris un nœud encore vide.
    const visible =
      isAllStatuses(statuses) ||
      ownedCount > 0 ||
      (statuses.includes('WISHLIST') && node.isWishlist);
    return visible ? { node, ownedCount } : null;
  }

  /** 404 si le nœud n'existe pas, sort de la collection visée, ou tombe hors des statuts exposés. */
  async findOne(access: CollectionAccess, id: string): Promise<NodeResponse> {
    const found = await this.visibleNode(access, id);
    if (!found) {
      throw new NotFoundException('Node not found');
    }
    return this.toResponse(found.node, found.ownedCount, access.role);
  }

  /** Snapshots bruts d'un nœud — catalogue public, rien de personnel (cf. `ItemsService`). */
  async getSources(
    access: CollectionAccess,
    id: string,
  ): Promise<SourceEntry[]> {
    const found = await this.visibleNode(access, id);
    if (!found) {
      throw new NotFoundException('Node not found');
    }
    return this.toEntries(found.node.sources);
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
        ? this.validateNodeUnified(level, dto.unifiedData as JsonRecord)
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
