import { BadRequestException } from '@nestjs/common';
import { CollectionTypeCode } from '../collections/collection-type-codes';
import { BnfService } from '../common/sources/bnf/bnf.service';
import { GoogleBooksCoverService } from '../common/sources/googlebooks/googlebooks.service';
import {
  AdapterSearchResult,
  SourceAdapter,
  UnifiedItem,
} from '../oauth/providers/types';
import { SearchService } from './search.service';

const bnfMock = { enumerateEdition: jest.fn() };
const bnf = bnfMock as unknown as BnfService;

const gbooksMock = { cachedCover: jest.fn(), resolveCover: jest.fn() };
const gbooks = gbooksMock as unknown as GoogleBooksCoverService;

beforeEach(() => {
  jest.clearAllMocks();
  gbooksMock.cachedCover.mockResolvedValue(null);
});

function makeService(adapters: SourceAdapter[]): SearchService {
  return new SearchService(adapters, bnf, gbooks);
}

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
    const svc = makeService([vinylAdapter, mangaAdapter]);

    const res = await svc.search(USER, 'vinyl', { q: 'miles' }, undefined, 50);

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
    const svc = makeService([adapter]);
    const res = await svc.search(USER, 'vinyl', { q: 'q' }, '1', 25);
    expect(res).toEqual({
      data: [VINYL_ITEM],
      meta: { pagination: { nextCursor: '2', limit: 25 } },
    });
  });

  it('propage le cursor au call adapter', async () => {
    const adapter = makeAdapter('vinyl', { items: [], nextCursor: null });
    const svc = makeService([adapter]);
    await svc.search(USER, 'vinyl', { q: 'q' }, 'cursor-from-client', 10);
    expect(adapter.search).toHaveBeenCalledWith('q', {
      userId: USER,
      cursor: 'cursor-from-client',
      limit: 10,
    });
  });

  it("throw BadRequest si aucun adapter n'est enregistré pour ce type (ex: book)", async () => {
    const vinyl = makeAdapter('vinyl', { items: [], nextCursor: null });
    const svc = makeService([vinyl]);
    await expect(
      svc.search(USER, 'book', { q: 'q' }, undefined, 10),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('route vers searchByBarcode quand un barcode est fourni', async () => {
    const adapter = makeAdapter('vinyl', {
      items: [VINYL_ITEM],
      nextCursor: null,
    });
    const barcodeMock = jest
      .fn()
      .mockResolvedValue({ items: [VINYL_ITEM], nextCursor: null });
    (adapter as unknown as { searchByBarcode: jest.Mock }).searchByBarcode =
      barcodeMock;
    const svc = makeService([adapter]);

    const res = await svc.search(
      USER,
      'vinyl',
      { barcode: '0888072024557' },
      undefined,
      50,
    );

    expect(barcodeMock).toHaveBeenCalledWith('0888072024557', {
      userId: USER,
      cursor: undefined,
      limit: 50,
    });
    expect(adapter.search).not.toHaveBeenCalled();
    expect(res.data).toEqual([VINYL_ITEM]);
  });

  it('throw BadRequest si barcode fourni mais adapter sans searchByBarcode', async () => {
    const adapter = makeAdapter('vinyl', { items: [], nextCursor: null });
    // makeAdapter ne définit pas searchByBarcode → capacité absente.
    const svc = makeService([adapter]);
    await expect(
      svc.search(USER, 'vinyl', { barcode: '0888072024557' }, undefined, 10),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('editionMapping délègue à la BnF et enrichit chaque tome avec la jaquette en cache (cache-only)', async () => {
    const mapping = {
      titleFr: "L'attaque des titans",
      edition: 'Éd. colossale',
      tomeCount: 2,
      tomes: [
        {
          editionVolume: 1,
          isbn: '111',
          titleFr: 'T.1',
          sourceVolumeRange: null,
        },
        {
          editionVolume: 2,
          isbn: null,
          titleFr: 'T.2',
          sourceVolumeRange: null,
        },
      ],
      recordsScanned: 30,
      ongoing: false,
    };
    bnfMock.enumerateEdition.mockResolvedValue(mapping);
    gbooksMock.cachedCover.mockImplementation(async (isbn: string) =>
      isbn === '111' ? 'https://img/1.jpg' : null,
    );
    const svc = makeService([]);

    const res = await svc.editionMapping(
      "L'attaque des titans",
      'Éd. colossale',
    );

    expect(bnfMock.enumerateEdition).toHaveBeenCalledWith(
      "L'attaque des titans",
      'Éd. colossale',
    );
    // Tome sans ISBN → aucune résolution tentée.
    expect(gbooksMock.cachedCover).toHaveBeenCalledTimes(1);
    expect(gbooksMock.cachedCover).toHaveBeenCalledWith('111');
    expect(res.tomeCount).toBe(2);
    expect(res.tomes).toEqual([
      {
        editionVolume: 1,
        isbn: '111',
        titleFr: 'T.1',
        sourceVolumeRange: null,
        coverUrl: 'https://img/1.jpg',
      },
      {
        editionVolume: 2,
        isbn: null,
        titleFr: 'T.2',
        sourceVolumeRange: null,
        coverUrl: null,
      },
    ]);
  });

  it('editionMapping passe null quand aucune édition (standard)', async () => {
    bnfMock.enumerateEdition.mockResolvedValue({ tomeCount: 34, tomes: [] });
    const svc = makeService([]);
    await svc.editionMapping('Naruto');
    expect(bnfMock.enumerateEdition).toHaveBeenCalledWith('Naruto', null);
  });

  it('resolveCover délègue à GoogleBooksCoverService', async () => {
    gbooksMock.resolveCover.mockResolvedValue('https://img/x.jpg');
    const svc = makeService([]);

    const url = await svc.resolveCover('978-2-505-01194-3');

    expect(gbooksMock.resolveCover).toHaveBeenCalledWith('978-2-505-01194-3');
    expect(url).toBe('https://img/x.jpg');
  });
});
