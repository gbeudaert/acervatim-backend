import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateItemDto } from './dto/create-item.dto';
import { ListItemsQueryDto } from './dto/list-items.query';
import { ItemsService } from './items.service';

@ApiTags('items')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Post('collections/:collectionId/items')
  async create(
    @CurrentUserId() userId: string,
    @Param('collectionId', new ParseUUIDPipe()) collectionId: string,
    @Body() dto: CreateItemDto,
  ) {
    return this.items.create(userId, collectionId, dto);
  }

  @Get('collections/:collectionId/items')
  async list(
    @CurrentUserId() userId: string,
    @Param('collectionId', new ParseUUIDPipe()) collectionId: string,
    @Query() query: ListItemsQueryDto,
  ) {
    return this.items.list(userId, collectionId, query);
  }

  @Get('items/:id')
  async findOne(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.items.findOne(userId, id);
  }

  @Delete('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.items.remove(userId, id);
  }
}
