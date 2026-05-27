import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Collection } from '@prisma/client';
import { CursorPage, paginate } from '../common/pagination/paginate';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { ListCollectionsQueryDto } from './dto/list-collections.query';
import { UpdateCollectionDto } from './dto/update-collection.dto';

@Injectable()
export class CollectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateCollectionDto): Promise<Collection> {
    const type = await this.prisma.collectionType.findUnique({
      where: { code: dto.typeCode },
      select: { id: true },
    });
    if (!type) {
      throw new BadRequestException(`Unknown collection type: ${dto.typeCode}`);
    }
    return this.prisma.collection.create({
      data: {
        userId,
        typeId: type.id,
        name: dto.name,
        description: dto.description,
      },
    });
  }

  async list(
    userId: string,
    query: ListCollectionsQueryDto,
  ): Promise<CursorPage<Collection>> {
    const where = {
      userId,
      ...(query.type ? { type: { code: query.type } } : {}),
    };
    return paginate(
      (take, cursor) =>
        this.prisma.collection.findMany({
          where,
          take,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          orderBy: { createdAt: 'desc' },
        }),
      query.cursor,
      query.limit,
    );
  }

  /** 404 si la collection appartient à un autre user (pas de 403 — pas de leak). */
  async findOne(userId: string, id: string): Promise<Collection> {
    const collection = await this.prisma.collection.findFirst({
      where: { id, userId },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    return collection;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateCollectionDto,
  ): Promise<Collection> {
    await this.findOne(userId, id); // 404 si pas à ce user
    return this.prisma.collection.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
      },
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.findOne(userId, id); // 404 si pas à ce user
    await this.prisma.collection.delete({ where: { id } });
  }
}
