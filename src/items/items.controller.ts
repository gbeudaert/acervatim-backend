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
import { CollectionPremiumGuard } from '../premium/collection-premium.guard';
import { CollectionRef } from '../premium/collection-ref.decorator';
import { PremiumGuard } from '../premium/premium.guard';
import { AttachItemSourceDto } from './dto/attach-source.dto';
import { CreateItemDto } from './dto/create-item.dto';
import { ListItemsQueryDto } from './dto/list-items.query';
import { UpdateItemDto } from './dto/update-item.dto';
import { ItemsService } from './items.service';

@ApiTags('items')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Post('collections/:collectionId/items')
  @UseGuards(PremiumGuard)
  async create(
    @CurrentUserId() userId: string,
    @Param('collectionId', new ParseUUIDPipe()) collectionId: string,
    @Body() dto: CreateItemDto,
  ) {
    return this.items.create(userId, collectionId, dto);
  }

  @Get('collections/:collectionId/items')
  @UseGuards(CollectionPremiumGuard)
  @CollectionRef('collection', 'collectionId')
  async list(
    @CurrentUserId() userId: string,
    @Param('collectionId', new ParseUUIDPipe()) collectionId: string,
    @Query() query: ListItemsQueryDto,
  ) {
    return this.items.list(userId, collectionId, query);
  }

  @Get('items/:id')
  @UseGuards(CollectionPremiumGuard)
  @CollectionRef('item', 'id')
  async findOne(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.items.findOne(userId, id);
  }

  @Get('items/:id/sources')
  @UseGuards(CollectionPremiumGuard)
  @CollectionRef('item', 'id')
  async sources(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.items.getSources(userId, id);
  }

  @Post('items/:id/sources')
  @UseGuards(PremiumGuard)
  async attachSource(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AttachItemSourceDto,
  ) {
    return this.items.attachSource(userId, id, dto);
  }

  @Patch('items/:id')
  @UseGuards(PremiumGuard)
  async update(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.items.update(userId, id, dto);
  }

  @Delete('items/:id')
  @UseGuards(PremiumGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.items.remove(userId, id);
  }
}
