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
import { CollectionAccess } from '../premium/collection-access.service';
import { CollectionPremiumGuard } from '../premium/collection-premium.guard';
import { CollectionRef } from '../premium/collection-ref.decorator';
import { CollectionWriteGuard } from '../premium/collection-write.guard';
import { CurrentCollectionAccess } from '../premium/current-collection-access.decorator';
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
  @UseGuards(CollectionWriteGuard)
  @CollectionRef('collection', 'collectionId')
  async create(
    @CurrentUserId() userId: string,
    @Param('collectionId', new ParseUUIDPipe()) collectionId: string,
    @Body() dto: CreateNodeDto,
  ) {
    return this.nodes.create(userId, collectionId, dto);
  }

  @Get('collections/:collectionId/nodes')
  @UseGuards(CollectionPremiumGuard)
  @CollectionRef('collection', 'collectionId')
  async list(
    @CurrentCollectionAccess() access: CollectionAccess,
    // Non consomme (deja dans `access`), mais le pipe doit rester : sans lui un
    // identifiant malforme ne serait plus un 400, le guard le laissant passer.
    @Param('collectionId', new ParseUUIDPipe()) _collectionId: string,
    @Query() query: ListNodesQueryDto,
  ) {
    return this.nodes.list(access, query);
  }

  @Get('nodes/:id')
  @UseGuards(CollectionPremiumGuard)
  @CollectionRef('node', 'id')
  async findOne(
    @CurrentCollectionAccess() access: CollectionAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.nodes.findOne(access, id);
  }

  @Get('nodes/:id/sources')
  @UseGuards(CollectionPremiumGuard)
  @CollectionRef('node', 'id')
  async sources(
    @CurrentCollectionAccess() access: CollectionAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.nodes.getSources(access, id);
  }

  @Patch('nodes/:id')
  @UseGuards(CollectionWriteGuard)
  @CollectionRef('node', 'id')
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
  @UseGuards(CollectionWriteGuard)
  @CollectionRef('node', 'id')
  async attachSource(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AttachNodeSourceDto,
  ) {
    return this.nodes.attachSource(userId, id, dto);
  }
}
