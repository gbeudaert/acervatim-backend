import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CursorPage } from '../common/pagination/paginate';
import { EditionMapping } from '../common/sources/bnf/bnf.types';
import { UnifiedItem } from '../oauth/providers/types';
import { EditionMappingQueryDto } from './dto/edition-mapping.query';
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
      { q: query.q, barcode: query.barcode },
      query.cursor,
      query.limit,
    );
  }

  /**
   * Énumère une édition manga complète (« récupérer toute la série d'un coup »).
   * Ex : `?title=L'attaque des titans&edition=Éd. colossale` → les 12 tomes Colossale
   * avec leur correspondance vers l'édition standard.
   */
  @Get('edition-mapping')
  async editionMapping(
    @Query() query: EditionMappingQueryDto,
  ): Promise<EditionMapping> {
    return this.search.editionMapping(query.title, query.edition);
  }
}
