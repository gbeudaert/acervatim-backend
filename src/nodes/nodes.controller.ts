import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AttachNodeSourceDto } from './dto/attach-source.dto';
import { CreateNodeDto } from './dto/create-node.dto';
import { ListNodesQueryDto } from './dto/list-nodes.query';
import { UpdateNodeDto } from './dto/update-node.dto';
import { NodesService } from './nodes.service';

@ApiTags('nodes')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Post('collections/:collectionId/nodes')
  async create(
    @CurrentUserId() userId: string,
    @Param('collectionId', new ParseUUIDPipe()) collectionId: string,
    @Body() dto: CreateNodeDto,
  ) {
    return this.nodes.create(userId, collectionId, dto);
  }

  @Get('collections/:collectionId/nodes')
  async list(
    @CurrentUserId() userId: string,
    @Param('collectionId', new ParseUUIDPipe()) collectionId: string,
    @Query() query: ListNodesQueryDto,
  ) {
    return this.nodes.list(userId, collectionId, query);
  }

  @Get('nodes/:id')
  async findOne(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.nodes.findOne(userId, id);
  }

  @Get('nodes/:id/sources')
  async sources(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.nodes.getSources(userId, id);
  }

  @Patch('nodes/:id')
  async update(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateNodeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.nodes.update(userId, id, dto);
    if (result === null) {
      // Purge (isWishlist=false & vide) → 204 No Content.
      res.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return result;
  }

  @Post('nodes/:id/sources')
  async attachSource(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AttachNodeSourceDto,
  ) {
    return this.nodes.attachSource(userId, id, dto);
  }
}
