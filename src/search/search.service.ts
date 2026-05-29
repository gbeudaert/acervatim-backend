import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CollectionTypeCode } from '../collections/collection-type-codes';
import { CursorPage } from '../common/pagination/paginate';
import { SOURCE_ADAPTERS } from '../common/sources/source-snapshot.service';
import { SourceAdapter, UnifiedItem } from '../oauth/providers/types';

@Injectable()
export class SearchService {
  private readonly byMediaType: Map<CollectionTypeCode, SourceAdapter>;

  constructor(@Inject(SOURCE_ADAPTERS) adapters: SourceAdapter[]) {
    this.byMediaType = new Map(adapters.map((a) => [a.mediaType, a]));
  }

  async search(
    userId: string,
    type: CollectionTypeCode,
    query: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<UnifiedItem>> {
    const adapter = this.byMediaType.get(type);
    if (!adapter) {
      throw new BadRequestException(
        `search not supported for type '${type}' yet`,
      );
    }
    const res = await adapter.search(query, { userId, cursor, limit });
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
