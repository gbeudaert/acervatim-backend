import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Collection, Prisma } from '@prisma/client';
import { CursorPage, paginate } from '../common/pagination/paginate';
import { LimitsService } from '../common/limits/limits.service';
import {
  accessStatuses,
  CollectionAccess,
} from '../premium/collection-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShareFilterService } from '../sharing/share-filter.service';
import { HierarchySummaryEntry, summarizeHierarchy } from './types/hierarchy';
import { getProfile } from './types/registry';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { ListCollectionsQueryDto } from './dto/list-collections.query';
import { UpdateCollectionDto } from './dto/update-collection.dto';

// On n'expose jamais l'UUID `typeId` : le client manipule le code stable
// (`vinyl`, `manga`, …), exposé sous `type`.
export type CollectionResponse = Omit<Collection, 'typeId'> & {
  type: string;
};

// Détail enrichi du résumé de hiérarchie (nœuds par niveau ; `[]` = type plat).
export type CollectionDetailResponse = CollectionResponse & {
  hierarchy: HierarchySummaryEntry[];
};

const TYPE_INCLUDE = { type: { select: { code: true } } };

// Champs de `unifiedData` couverts par la recherche items[in]/items[all].
const ITEM_SEARCH_FIELDS = ['title', 'name', 'artist', 'author'] as const;

// `string_contains` de Prisma compare via JSON_UNQUOTE(...), qui sort en collation
// utf8mb4_bin (sensible à la casse) sur MariaDB, et MySQL n'a pas de `mode: insensitive`.
// On passe donc par du SQL paramétré avec COLLATE utf8mb4_general_ci pour un contains CI.
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: LimitsService,
    private readonly shareFilter: ShareFilterService,
  ) {}

  private toResponse(
    collection: Collection & { type: { code: string } },
  ): CollectionResponse {
    return {
      id: collection.id,
      userId: collection.userId,
      name: collection.name,
      description: collection.description,
      itemCount: collection.itemCount,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
      type: collection.type.code,
    };
  }

  // IDs des collections de `userId` ayant >= 1 item dont un champ recherché contient
  // `term` (contains case-insensitive). Un appel SQL par terme.
  private async matchingCollectionIds(
    userId: string,
    term: string,
  ): Promise<string[]> {
    const pattern = `%${escapeLike(term)}%`;
    const clauses = ITEM_SEARCH_FIELDS.map(
      (field) =>
        Prisma.sql`JSON_UNQUOTE(JSON_EXTRACT(i.unified_data, ${`$.${field}`})) COLLATE utf8mb4_general_ci LIKE ${pattern}`,
    );
    const rows = await this.prisma.$queryRaw<{ collectionId: string }[]>`
      SELECT DISTINCT i.collection_id AS collectionId
      FROM items i
      WHERE i.user_id = ${userId}
        AND (${Prisma.join(clauses, ' OR ')})
    `;
    return rows.map((r) => r.collectionId);
  }

  // Combine items[in] (OR = union des termes) et items[all] (AND = un set par terme),
  // puis intersecte le tout (les filtres se combinent en AND). Set d'IDs éventuellement vide.
  private async resolveItemFilterIds(
    userId: string,
    items: { in?: string[]; all?: string[] },
  ): Promise<string[]> {
    const sets: Set<string>[] = [];
    if (items.in) {
      const union = new Set<string>();
      for (const term of items.in) {
        for (const id of await this.matchingCollectionIds(userId, term)) {
          union.add(id);
        }
      }
      sets.push(union);
    }
    if (items.all) {
      for (const term of items.all) {
        sets.push(new Set(await this.matchingCollectionIds(userId, term)));
      }
    }
    if (sets.length === 0) {
      return [];
    }
    let acc = [...sets[0]];
    for (let i = 1; i < sets.length; i++) {
      acc = acc.filter((id) => sets[i].has(id));
    }
    return acc;
  }

  /** 404 si la collection appartient à un autre user (pas de 403 — pas de leak). */
  private async assertOwned(userId: string, id: string): Promise<void> {
    const collection = await this.prisma.collection.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
  }

  async create(
    userId: string,
    dto: CreateCollectionDto,
  ): Promise<CollectionResponse> {
    // typeCode → typeId hors-tx : lookup pur en lecture, indépendant du plafond.
    const type = await this.prisma.collectionType.findUnique({
      where: { code: dto.typeCode },
      select: { id: true },
    });
    if (!type) {
      throw new BadRequestException(`Unknown collection type: ${dto.typeCode}`);
    }
    // Plafond technique + create dans la même tx : réduit la fenêtre TOCTOU
    // sous concurrence (sans SELECT FOR UPDATE le risque reste, cf. review SEC-004).
    return this.prisma.$transaction(async (tx) => {
      await this.limits.assertCanCreateCollection(userId, tx);
      const collection = await tx.collection.create({
        data: {
          userId,
          typeId: type.id,
          name: dto.name,
          description: dto.description,
        },
        include: TYPE_INCLUDE,
      });
      return this.toResponse(collection);
    });
  }

  async list(
    userId: string,
    query: ListCollectionsQueryDto,
  ): Promise<CursorPage<CollectionResponse>> {
    const where: Prisma.CollectionWhereInput = {
      userId,
      ...(query.type ? { type: { code: query.type } } : {}),
    };
    if (query.items) {
      const ids = await this.resolveItemFilterIds(userId, query.items);
      if (ids.length === 0) {
        // Aucun item ne matche → page vide (évite un `IN ()` et une requête inutile).
        return {
          data: [],
          meta: { pagination: { nextCursor: null, limit: query.limit } },
        };
      }
      where.id = { in: ids };
    }
    const page = await paginate(
      (take, cursor) =>
        this.prisma.collection.findMany({
          where,
          take,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          // id desc en tiebreaker : deux rows avec le même createdAt (bulk insert,
          // fixtures) ne se retrouvent jamais dupliquées ou sautées entre pages.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: TYPE_INCLUDE,
        }),
      query.cursor,
      query.limit,
    );
    return { ...page, data: page.data.map((c) => this.toResponse(c)) };
  }

  /**
   * Détail d'une collection, du point de vue du requérant.
   *
   * Pour un membre, les compteurs sont **recalculés sous ce qui lui est exposé** : `itemCount` est
   * dénormalisé sur la collection entière et le résumé de hiérarchie compte tous les nœuds. Servis
   * tels quels, ils afficheraient « 240 éléments » et « 30 séries » sur une vue qui en montre 12 et
   * 3. Le compte reste utile au membre — il doit juste être celui de ce qu'il voit.
   */
  async findOne(access: CollectionAccess): Promise<CollectionDetailResponse> {
    const id = access.collectionId;
    const collection = await this.prisma.collection.findUnique({
      where: { id },
      include: TYPE_INCLUDE,
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    const statuses = accessStatuses(access);
    const profile = getProfile(collection.type.code);
    let hierarchy: HierarchySummaryEntry[] = [];
    if (profile.hierarchy.length > 0) {
      const scoped = await this.shareFilter.nodeWhere(id, statuses);
      const groups = await this.prisma.collectionNode.groupBy({
        by: ['level'],
        where: { collectionId: id, ...(scoped ? { AND: [scoped] } : {}) },
        _count: { _all: true },
      });
      const counts: Record<string, number> = Object.fromEntries(
        groups.map((g) => [g.level, g._count._all]),
      );
      hierarchy = summarizeHierarchy(profile, counts);
    }
    const response = this.toResponse(collection);
    if (access.role === 'shared') {
      response.itemCount = await this.shareFilter.countItems(id, statuses);
    }
    return { ...response, hierarchy };
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateCollectionDto,
  ): Promise<CollectionResponse> {
    await this.assertOwned(userId, id); // 404 si pas à ce user
    const collection = await this.prisma.collection.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
      },
      include: TYPE_INCLUDE,
    });
    return this.toResponse(collection);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.assertOwned(userId, id); // 404 si pas à ce user
    await this.prisma.collection.delete({ where: { id } });
  }
}
