import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CursorPage } from '../common/pagination/paginate';
import { UnifiedItem } from '../oauth/providers/types';
import { SearchQueryDto } from './dto/search.query';
import { SearchService } from './search.service';

@ApiTags('search')
@ApiBearerAuth()
@Controller('search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  async list(
    @CurrentUserId() userId: string,
    @Query() query: SearchQueryDto,
  ): Promise<CursorPage<UnifiedItem>> {
    return this.search.search(
      userId,
      query.type,
      query.q,
      query.cursor,
      query.limit,
    );
  }
}
