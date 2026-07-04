import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CollectionTypeCode } from '../collections/collection-type-codes';
import { CursorPage } from '../common/pagination/paginate';
import { BnfService } from '../common/sources/bnf/bnf.service';
import { EditionMapping, EditionTome } from '../common/sources/bnf/bnf.types';
import { GoogleBooksCoverService } from '../common/sources/googlebooks/googlebooks.service';
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

/**
 * Tome d'édition + jaquette (Google Books, par ISBN). `coverUrl` est peuplé côté search — la BnF
 * n'en fournit pas — d'où ce type de réponse distinct qui laisse `EditionTome` (couche BnF) pur.
 */
export interface EditionTomeWithCover extends EditionTome {
  coverUrl: string | null;
}

export interface EditionMappingResponse extends Omit<EditionMapping, 'tomes'> {
  tomes: EditionTomeWithCover[];
}

@Injectable()
export class SearchService {
  private readonly byMediaType: Map<CollectionTypeCode, SourceAdapter>;

  constructor(
    @Inject(SOURCE_ADAPTERS) adapters: SourceAdapter[],
    private readonly bnf: BnfService,
    private readonly googleBooks: GoogleBooksCoverService,
  ) {
    this.byMediaType = new Map(adapters.map((a) => [a.mediaType, a]));
  }

  /**
   * Énumère une édition manga complète (« toute la série d'un coup ») via la BnF, puis attache à
   * chaque tome sa jaquette Google Books **si déjà en cache serveur** (lecture cache-only : aucun
   * appel externe ici, la latence reste celle de la BnF). La résolution réseau des jaquettes se fait
   * via `resolveCover` / l'endpoint `GET /v1/search/cover`, qui alimente ce cache.
   */
  async editionMapping(
    titleFr: string,
    edition?: string,
  ): Promise<EditionMappingResponse> {
    const mapping = await this.bnf.enumerateEdition(titleFr, edition ?? null);
    const tomes = await Promise.all(
      mapping.tomes.map(async (tome) => ({
        ...tome,
        coverUrl: tome.isbn
          ? await this.googleBooks.cachedCover(tome.isbn)
          : null,
      })),
    );
    return { ...mapping, tomes };
  }

  /**
   * Résout (réseau, best-effort) et met en cache la jaquette d'un tome par ISBN. Renvoie `null` si
   * aucune jaquette n'est trouvée ou en cas d'échec — jamais d'erreur propagée.
   */
  async resolveCover(isbn: string): Promise<string | null> {
    return this.googleBooks.resolveCover(isbn);
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
