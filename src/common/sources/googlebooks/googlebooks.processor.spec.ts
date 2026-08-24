import { Job } from 'bullmq';
import { GoogleBooksProcessor } from './googlebooks.processor';
import {
  CoverJobData,
  CoverResult,
  FAIL_TTL_SECONDS,
  GBOOKS_COVER_JOB,
  GBOOKS_VOLUME_INFO_JOB,
  GBooksJobData,
  GBooksJobResult,
  HIT_TTL_SECONDS,
  MISS_TTL_SECONDS,
  VolumeInfoJobData,
} from './googlebooks.types';

function make() {
  const cache = { set: jest.fn() };
  const resolver = { fetchCover: jest.fn(), fetchVolumeInfo: jest.fn() };
  const proc = new GoogleBooksProcessor(resolver as never, cache as never);
  return { proc, cache, resolver };
}

function job(data: CoverJobData): Job<CoverJobData, CoverResult> {
  return { data, name: GBOOKS_COVER_JOB } as Job<CoverJobData, CoverResult>;
}

/** Job `volume-info` — c'est `job.name` qui discrimine les deux jobs de la file `gbooks`. */
function volumeInfoJob(
  data: VolumeInfoJobData,
): Job<GBooksJobData, GBooksJobResult> {
  return { data, name: GBOOKS_VOLUME_INFO_JOB } as Job<
    GBooksJobData,
    GBooksJobResult
  >;
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

describe('GoogleBooksProcessor.process — job volume-info (titre par ISBN)', () => {
  it('cache le titre trouvé en TTL long (un titre est stable) et le renvoie', async () => {
    const { proc, cache, resolver } = make();
    const info = {
      title: 'Sentenced to be a Hero Tome 1',
      authors: ['Rokurou Akashi'],
      publishedDate: '2026-05-22',
    };
    resolver.fetchVolumeInfo.mockResolvedValue(info);

    const res = await proc.process(volumeInfoJob({ isbn: '9782808703437' }));

    expect(res).toEqual({ info });
    expect(cache.set).toHaveBeenCalledWith(
      'gbooks:volume:9782808703437',
      { info },
      HIT_TTL_SECONDS,
    );
    // La jaquette n'est pas résolue au passage : deux jobs, deux clés.
    expect(resolver.fetchCover).not.toHaveBeenCalled();
  });

  it('cache une absence légitime (Google ne connaît pas cet ISBN) en TTL court', async () => {
    const { proc, cache, resolver } = make();
    resolver.fetchVolumeInfo.mockResolvedValue(null);

    const res = await proc.process(volumeInfoJob({ isbn: '9782344073674' }));

    expect(res).toEqual({ info: null });
    // TTL court : une notice Google peut apparaître plus tard pour une nouveauté.
    expect(cache.set).toHaveBeenCalledWith(
      'gbooks:volume:9782344073674',
      { info: null },
      MISS_TTL_SECONDS,
    );
  });

  it('pose un cache négatif court (FAIL_TTL) sur échec dur puis propage', async () => {
    const { proc, cache, resolver } = make();
    resolver.fetchVolumeInfo.mockRejectedValue(new Error('google 503'));

    await expect(
      proc.process(volumeInfoJob({ isbn: '9782808703437' })),
    ).rejects.toThrow('google 503');
    expect(cache.set).toHaveBeenCalledWith(
      'gbooks:volume:9782808703437',
      { info: null },
      FAIL_TTL_SECONDS,
    );
  });
});
