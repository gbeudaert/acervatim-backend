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

  @Get()
  @UseGuards(PremiumGuard)
  async list(
    @CurrentUserId() userId: string,
    @Query() query: ListCollectionsQueryDto,
  ) {
    return this.collections.list(userId, query);
  }

  @Get(':id')
  @UseGuards(CollectionPremiumGuard)
  @CollectionRef('collection', 'id')
  async findOne(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.collections.findOne(userId, id);
  }

  @Patch(':id')
  @UseGuards(PremiumGuard)
  async update(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.collections.update(userId, id, dto);
  }

  @Delete(':id')
  @UseGuards(PremiumGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.collections.remove(userId, id);
  }
}
