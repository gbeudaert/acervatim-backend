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
  async create(
    @CurrentUserId() userId: string,
    @Body() dto: CreateCollectionDto,
  ) {
    return this.collections.create(userId, dto);
  }

  @Get()
  async list(
    @CurrentUserId() userId: string,
    @Query() query: ListCollectionsQueryDto,
  ) {
    return this.collections.list(userId, query);
  }

  @Get(':id')
  async findOne(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.collections.findOne(userId, id);
  }

  @Patch(':id')
  async update(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.collections.update(userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.collections.remove(userId, id);
  }
}
