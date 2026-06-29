import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CollectionTypeCode } from '../collections/collection-type-codes';
import { CursorPage } from '../common/pagination/paginate';
import { BnfService } from '../common/sources/bnf/bnf.service';
import { EditionMapping } from '../common/sources/bnf/bnf.types';
import { SOURCE_ADAPTERS } from '../common/sources/source-snapshot.service';
import {
  AdapterSearchResult,
  SourceAdapter,
  UnifiedItem,
} from '../oauth/providers/types';

/** Critère de recherche : exactement un des deux est défini (garanti par le DTO). */
export interface SearchCriteria {
  q?: string;
  barcode?: string;
}

@Injectable()
export class SearchService {
  private readonly byMediaType: Map<CollectionTypeCode, SourceAdapter>;

  constructor(
    @Inject(SOURCE_ADAPTERS) adapters: SourceAdapter[],
    private readonly bnf: BnfService,
  ) {
    this.byMediaType = new Map(adapters.map((a) => [a.mediaType, a]));
  }

  /**
   * Énumère une édition manga complète (« toute la série d'un coup ») via la BnF.
   * Sert à afficher le bon nombre de tomes (ex 12 pour la Colossale) et leur
   * correspondance avec l'édition source.
   */
  async editionMapping(
    titleFr: string,
    edition?: string,
  ): Promise<EditionMapping> {
    return this.bnf.enumerateEdition(titleFr, edition ?? null);
  }

  async search(
    userId: string,
    type: CollectionTypeCode,
    criteria: SearchCriteria,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<UnifiedItem>> {
    const adapter = this.byMediaType.get(type);
    if (!adapter) {
      throw new BadRequestException(
        `search not supported for type '${type}' yet`,
      );
    }
    const ctx = { userId, cursor, limit };
    let res: AdapterSearchResult;
    if (criteria.barcode) {
      if (!adapter.searchByBarcode) {
        throw new BadRequestException(
          `barcode search not supported for type '${type}'`,
        );
      }
      res = await adapter.searchByBarcode(criteria.barcode, ctx);
    } else {
      res = await adapter.search(criteria.q ?? '', ctx);
    }
    return {
      data: res.items,
      meta: {
        pagination: {
          nextCursor: res.nextCursor,
          limit,
        },
      },
    };
  }
}
