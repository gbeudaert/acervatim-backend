import { Job } from 'bullmq';
import { EditionImportProcessor } from './edition-import.processor';
import {
  EditionImportJobData,
  EditionImportResult,
} from './edition-import.types';

function make() {
  const search = { warmEditionMapping: jest.fn() };
  const proc = new EditionImportProcessor(search as never);
  return { proc, search };
}

function job(data: EditionImportJobData): Job<
  EditionImportJobData,
  EditionImportResult
> & {
  updateProgress: jest.Mock;
} {
  return {
    data,
    updateProgress: jest.fn().mockResolvedValue(undefined),
  } as never;
}

describe('EditionImportProcessor.process', () => {
  it('énumère, relaie la progression et renvoie le nb de tomes', async () => {
    const { proc, search } = make();
    // Simule 3 tomes résolus en appelant le callback de progression.
    search.warmEditionMapping.mockImplementation(
      async (
        _title: string,
        _edition: string | undefined,
        onProgress: (d: number, t: number) => void,
      ) => {
        onProgress(1, 3);
        onProgress(2, 3);
        onProgress(3, 3);
        return { tomes: [{}, {}, {}] };
      },
    );

    const j = job({
      title: 'Black torch',
      edition: null,
      malId: null,
      mangaId: null,
      publisher: null,
    });
    const res = await proc.process(j);

    expect(res).toEqual<EditionImportResult>({ tomeCount: 3 });
    // edition null + malId/mangaId/publisher null → transmis en undefined à warmEditionMapping.
    expect(search.warmEditionMapping).toHaveBeenCalledWith(
      'Black torch',
      undefined,
      expect.any(Function),
      undefined,
      undefined,
      undefined,
    );
    // Phase d'énumération annoncée, puis progression des jaquettes.
    expect(j.updateProgress).toHaveBeenCalledWith({
      phase: 'enumerating',
      done: 0,
      total: 0,
    });
    expect(j.updateProgress).toHaveBeenCalledWith({
      phase: 'covers',
      done: 3,
      total: 3,
    });
  });

  it('transmet l’édition quand elle est fournie', async () => {
    const { proc, search } = make();
    search.warmEditionMapping.mockResolvedValue({ tomes: [] });

    await proc.process(
      job({
        title: 'X',
        edition: 'Éd. colossale',
        malId: null,
        mangaId: null,
        publisher: null,
      }),
    );

    expect(search.warmEditionMapping).toHaveBeenCalledWith(
      'X',
      'Éd. colossale',
      expect.any(Function),
      undefined,
      undefined,
      undefined,
    );
  });

  it('transmet l’éditeur et le mangaId (import lancé depuis la recherche par titre)', async () => {
    const { proc, search } = make();
    search.warmEditionMapping.mockResolvedValue({ tomes: [] });

    await proc.process(
      job({
        title: "L'attaque des titans",
        edition: null,
        malId: null,
        mangaId: 'md-1',
        publisher: 'Pika',
      }),
    );

    expect(search.warmEditionMapping).toHaveBeenCalledWith(
      "L'attaque des titans",
      undefined,
      expect.any(Function),
      undefined,
      'md-1',
      'Pika',
    );
  });
});
