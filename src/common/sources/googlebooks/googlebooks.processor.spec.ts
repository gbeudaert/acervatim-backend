import { Job } from 'bullmq';
import { GoogleBooksProcessor } from './googlebooks.processor';
import {
  CoverJobData,
  CoverResult,
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
    });

    const res = await proc.process(job({ isbn: '9782505011943', hint: null }));

    expect(res).toEqual({
      coverUrl: 'https://img/c.jpg',
      description: 'Résumé',
    });
    expect(cache.set).toHaveBeenCalledWith(
      'gbooks:cover:9782505011943',
      { url: 'https://img/c.jpg', description: 'Résumé' },
      HIT_TTL_SECONDS,
    );
  });

  it('cache une absence légitime (2xx sans image) en TTL court', async () => {
    const { proc, cache, resolver } = make();
    resolver.fetchCover.mockResolvedValue({
      coverUrl: null,
      description: null,
    });

    await proc.process(
      job({
        isbn: '9791032701881',
        hint: { title: 'Black torch', volume: 1, edition: null },
      }),
    );

    expect(cache.set).toHaveBeenCalledWith(
      'gbooks:cover:9791032701881',
      { url: null, description: null },
      MISS_TTL_SECONDS,
    );
  });

  it('n’écrit rien en cache si la résolution échoue (pas de cache hors 2xx) et propage', async () => {
    const { proc, cache, resolver } = make();
    resolver.fetchCover.mockRejectedValue(new Error('boom'));

    await expect(
      proc.process(job({ isbn: '9782505011943', hint: null })),
    ).rejects.toThrow('boom');
    expect(cache.set).not.toHaveBeenCalled();
  });
});
