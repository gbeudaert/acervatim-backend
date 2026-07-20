import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CoverStatus } from '../common/sources/googlebooks/googlebooks.types';
import { CursorPage } from '../common/pagination/paginate';
import { UnifiedItem } from '../oauth/providers/types';
import { CoverQueryDto } from './dto/cover.query';
import { EditionMappingQueryDto } from './dto/edition-mapping.query';
import { SearchQueryDto } from './dto/search.query';
import { EditionMappingResponse, SearchService } from './search.service';

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
  ): Promise<EditionMappingResponse> {
    return this.search.editionMapping(query.title, query.edition, query.malId);
  }

  /**
   * Résout la jaquette d'un tome par ISBN via Google Books (et la met en cache serveur, ce qui
   * alimente `edition-mapping`). Renvoie `coverStatus` (cf. {@link CoverStatus}) pour distinguer
   * `found` / `absent` (pas de jaquette, définitif) / `unresolved` (transitoire, à re-tenter).
   *
   * Passer `title`+`volume` (et `edition` si spéciale) arme le repli `intitle:` quand la notice ISBN
   * n'a pas d'image — indispensable pour les ISBN papier FR sans jaquette (cf. `resolveCover`).
   */
  @Get('cover')
  async cover(
    @Query() query: CoverQueryDto,
  ): Promise<{ coverUrl: string | null; coverStatus: CoverStatus }> {
    const hint =
      query.title != null && query.volume != null
        ? {
            title: query.title,
            volume: query.volume,
            edition: query.edition ?? null,
          }
        : undefined;
    return this.search.resolveCoverDetailed(query.isbn, hint);
  }
}
