import { Job } from 'bullmq';
import { GoogleBooksProcessor } from './googlebooks.processor';
import {
  CoverJobData,
  CoverResult,
  FAIL_TTL_SECONDS,
  HIT_TTL_SECONDS,
  MISS_TTL_SECONDS,
} from './googlebooks.types';

function make() {
  const cache = { set: jest.fn() };
  const resolver = { fetchCover: jest.fn() };
  const proc = new GoogleBooksProcessor(resolver as never, cache as never);
  return { proc, cache, resolver };
}

function job(data: CoverJobData): Job<CoverJobData, CoverResult> {
  return { data } as Job<CoverJobData, CoverResult>;
}

describe('GoogleBooksProcessor.process', () => {
  it('cache la jaquette résolue (2xx avec image) en TTL long et la renvoie', async () => {
    const { proc, cache, resolver } = make();
    resolver.fetchCover.mockResolvedValue({
      coverUrl: 'https://img/c.jpg',
      description: 'Résumé',
      status: 'found',
    });

    const res = await proc.process(job({ isbn: '9782505011943', hint: null }));

    expect(res).toEqual({
      coverUrl: 'https://img/c.jpg',
      description: 'Résumé',
      status: 'found',
    });
    expect(cache.set).toHaveBeenCalledWith(
      'gbooks:cover:9782505011943',
      { url: 'https://img/c.jpg', description: 'Résumé', status: 'found' },
      HIT_TTL_SECONDS,
    );
  });

  it('cache une absence légitime (2xx sans image) en TTL court', async () => {
    const { proc, cache, resolver } = make();
    resolver.fetchCover.mockResolvedValue({
      coverUrl: null,
      description: null,
      status: 'absent',
    });

    await proc.process(
      job({
        isbn: '9791032701881',
        hint: { title: 'Black torch', volume: 1, edition: null },
      }),
    );

    expect(cache.set).toHaveBeenCalledWith(
      'gbooks:cover:9791032701881',
      { url: null, description: null, status: 'absent' },
      MISS_TTL_SECONDS,
    );
  });

  it('pose un cache négatif court (FAIL_TTL) sur échec dur puis propage', async () => {
    const { proc, cache, resolver } = make();
    resolver.fetchCover.mockRejectedValue(new Error('boom'));

    await expect(
      proc.process(job({ isbn: '9782505011943', hint: null })),
    ).rejects.toThrow('boom');
    // Cache négatif court : coupe le ré-enqueue par de nouveaux scans pendant la vague 429/503,
    // sans masquer durablement une jaquette réellement disponible.
    expect(cache.set).toHaveBeenCalledWith(
      'gbooks:cover:9782505011943',
      { url: null, description: null, status: 'unresolved' },
      FAIL_TTL_SECONDS,
    );
  });
});
