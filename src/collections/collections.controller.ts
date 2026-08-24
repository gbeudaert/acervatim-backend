import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CollectionAccess } from '../premium/collection-access.service';
import { CollectionPremiumGuard } from '../premium/collection-premium.guard';
import { CollectionRef } from '../premium/collection-ref.decorator';
import { CollectionWriteGuard } from '../premium/collection-write.guard';
import { CurrentCollectionAccess } from '../premium/current-collection-access.decorator';
import { PremiumGuard } from '../premium/premium.guard';
import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { ListCollectionsQueryDto } from './dto/list-collections.query';
import { UpdateCollectionDto } from './dto/update-collection.dto';

@ApiTags('collections')
@ApiBearerAuth()
@Controller('collections')
@UseGuards(JwtAuthGuard)
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Post()
  @UseGuards(PremiumGuard)
  async create(
    @CurrentUserId() userId: string,
    @Body() dto: CreateCollectionDto,
  ) {
    return this.collections.create(userId, dto);
  }

  /**
   * **Mes** collections uniquement. Celles qu'on me partage ne s'y mélangent pas : elles se
   * listent par `GET /v1/shares/received`, qui porte en plus la portée et le partage d'origine.
   * Les confondre ferait entrer des collections d'autrui dans les compteurs et les plafonds du
   * requérant, et brouillerait les écrans « ma collection » de l'app.
   */
  @Get()
  @UseGuards(PremiumGuard)
  async list(
    @CurrentUserId() userId: string,
    @Query() query: ListCollectionsQueryDto,
  ) {
    return this.collections.list(userId, query);
  }

  /**
   * `id` n'est pas consommé — il est déjà dans `access` — mais le `ParseUUIDPipe` reste : sans lui
   * un identifiant malformé ne serait plus refusé en 400, le guard le laissant passer sans résoudre.
   */
  @Get(':id')
  @UseGuards(CollectionPremiumGuard)
  @CollectionRef('collection', 'id')
  async findOne(
    @CurrentCollectionAccess() access: CollectionAccess,
    @Param('id', new ParseUUIDPipe()) _id: string,
  ) {
    return this.collections.findOne(access);
  }

  @Patch(':id')
  @UseGuards(CollectionWriteGuard)
  @CollectionRef('collection', 'id')
  async update(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.collections.update(userId, id, dto);
  }

  @Delete(':id')
  @UseGuards(CollectionWriteGuard)
  @CollectionRef('collection', 'id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.collections.remove(userId, id);
  }
}
