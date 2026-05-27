import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Item, Prisma } from '@prisma/client';
import { CursorPage, paginate } from '../common/pagination/paginate';
import { QuotaService } from '../common/quota/quota.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateItemDto } from './dto/create-item.dto';
import { ListItemsQueryDto } from './dto/list-items.query';

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: QuotaService,
  ) {}

  /** 404 si la collection n'existe pas OU appartient à un autre user (pas de leak). */
  private async assertCollectionOwned(
    userId: string,
    collectionId: string,
  ): Promise<void> {
    const collection = await this.prisma.collection.findFirst({
      where: { id: collectionId, userId },
      select: { id: true },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
  }

  async create(
    userId: string,
    collectionId: string,
    dto: CreateItemDto,
  ): Promise<Item> {
    await this.assertCollectionOwned(userId, collectionId);
    await this.quota.assertCanCreateItem(userId);
    try {
      const [item] = await this.prisma.$transaction([
        this.prisma.item.create({
          data: {
            collectionId,
            userId,
            source: dto.source,
            sourceId: dto.sourceId,
            unifiedData: dto.unifiedData as Prisma.InputJsonValue,
            rawData: dto.rawData as Prisma.InputJsonValue,
          },
        }),
        this.prisma.collection.update({
          where: { id: collectionId },
          data: { itemCount: { increment: 1 } },
        }),
      ]);
      return item;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('item déjà ajouté');
      }
      throw err;
    }
  }

  async list(
    userId: string,
    collectionId: string,
    query: ListItemsQueryDto,
  ): Promise<CursorPage<Item>> {
    await this.assertCollectionOwned(userId, collectionId);
    const where: Prisma.ItemWhereInput = {
      collectionId,
      userId,
      ...(query.source ? { source: query.source } : {}),
    };
    return paginate(
      (take, cursor) =>
        this.prisma.item.findMany({
          where,
          take,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          orderBy: { createdAt: 'desc' },
        }),
      query.cursor,
      query.limit,
    );
  }

  /** 404 si l'item appartient à un autre user (scope via `userId` dénormalisé). */
  async findOne(userId: string, id: string): Promise<Item> {
    const item = await this.prisma.item.findFirst({
      where: { id, userId },
    });
    if (!item) {
      throw new NotFoundException('Item not found');
    }
    return item;
  }

  async remove(userId: string, id: string): Promise<void> {
    const item = await this.findOne(userId, id);
    await this.prisma.$transaction([
      this.prisma.item.delete({ where: { id } }),
      this.prisma.collection.update({
        where: { id: item.collectionId },
        data: { itemCount: { decrement: 1 } },
      }),
    ]);
  }
}
