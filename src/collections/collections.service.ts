import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Collection } from '@prisma/client';
import { CursorPage, paginate } from '../common/pagination/paginate';
import { QuotaService } from '../common/quota/quota.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { ListCollectionsQueryDto } from './dto/list-collections.query';
import { UpdateCollectionDto } from './dto/update-collection.dto';

// On n'expose jamais l'UUID `typeId` : le client manipule le code stable
// (`vinyl`, `manga`, …), exposé sous `type`.
export type CollectionResponse = Omit<Collection, 'typeId'> & {
  type: string;
};

const TYPE_INCLUDE = { type: { select: { code: true } } };

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: QuotaService,
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
    // typeCode → typeId hors-tx : lookup pur en lecture, indépendant du quota.
    const type = await this.prisma.collectionType.findUnique({
      where: { code: dto.typeCode },
      select: { id: true },
    });
    if (!type) {
      throw new BadRequestException(`Unknown collection type: ${dto.typeCode}`);
    }
    // Quota check + create dans la même tx : réduit la fenêtre TOCTOU
    // sous concurrence (sans SELECT FOR UPDATE le risque reste, cf. review SEC-004).
    return this.prisma.$transaction(async (tx) => {
      await this.quota.assertCanCreateCollection(userId, tx);
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
    const where = {
      userId,
      ...(query.type ? { type: { code: query.type } } : {}),
    };
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

  async findOne(userId: string, id: string): Promise<CollectionResponse> {
    const collection = await this.prisma.collection.findFirst({
      where: { id, userId },
      include: TYPE_INCLUDE,
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    return this.toResponse(collection);
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
