import { BadRequestException } from '@nestjs/common';
import { CollectionTypeCode } from '../collections/collection-type-codes';
import {
  AdapterSearchResult,
  SourceAdapter,
  UnifiedItem,
} from '../oauth/providers/types';
import { SearchService } from './search.service';

function makeAdapter(
  mediaType: CollectionTypeCode,
  result: AdapterSearchResult,
): SourceAdapter {
  return {
    source: 'discogs' as const,
    mediaType,
    search: jest.fn().mockResolvedValue(result),
    fetchDetails: jest.fn(),
  } as unknown as SourceAdapter;
}

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

const VINYL_ITEM: UnifiedItem = {
  source: 'discogs',
  sourceId: '1',
  mediaType: 'vinyl',
  title: 'Album',
  creators: ['Artist'],
  rawData: {},
};

describe('SearchService', () => {
  it("route vers l'adapter correspondant au type", async () => {
    const vinylAdapter = makeAdapter('vinyl', {
      items: [VINYL_ITEM],
      nextCursor: null,
    });
    const mangaAdapter = makeAdapter('manga', {
      items: [],
      nextCursor: null,
    });
    const svc = new SearchService([vinylAdapter, mangaAdapter]);

    const res = await svc.search(USER, 'vinyl', 'miles', undefined, 50);

    expect(vinylAdapter.search).toHaveBeenCalledWith('miles', {
      userId: USER,
      cursor: undefined,
      limit: 50,
    });
    expect(mangaAdapter.search).not.toHaveBeenCalled();
    expect(res.data).toEqual([VINYL_ITEM]);
  });

  it('wrappe la réponse en CursorPage avec nextCursor + limit dans meta.pagination', async () => {
    const adapter = makeAdapter('vinyl', {
      items: [VINYL_ITEM],
      nextCursor: '2',
    });
    const svc = new SearchService([adapter]);
    const res = await svc.search(USER, 'vinyl', 'q', '1', 25);
    expect(res).toEqual({
      data: [VINYL_ITEM],
      meta: { pagination: { nextCursor: '2', limit: 25 } },
    });
  });

  it('propage le cursor au call adapter', async () => {
    const adapter = makeAdapter('vinyl', { items: [], nextCursor: null });
    const svc = new SearchService([adapter]);
    await svc.search(USER, 'vinyl', 'q', 'cursor-from-client', 10);
    expect(adapter.search).toHaveBeenCalledWith('q', {
      userId: USER,
      cursor: 'cursor-from-client',
      limit: 10,
    });
  });

  it("throw BadRequest si aucun adapter n'est enregistré pour ce type (ex: book)", async () => {
    const vinyl = makeAdapter('vinyl', { items: [], nextCursor: null });
    const svc = new SearchService([vinyl]);
    await expect(
      svc.search(USER, 'book', 'q', undefined, 10),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
