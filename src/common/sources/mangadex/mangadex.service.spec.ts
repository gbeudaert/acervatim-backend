import { MangaDexCoverService } from './mangadex.service';
import {
  MANGADEX_COVERS_JOB,
  MANGADEX_IDENTIFY_JOB,
  MANGADEX_PRIORITY_BACKGROUND,
  MANGADEX_PRIORITY_INTERACTIVE,
  MANGADEX_SEARCH_JOB,
  MANGADEX_SERIES_JOB,
} from './mangadex.types';

function make() {
  const queue = {
    add: jest.fn().mockResolvedValue({
      waitUntilFinished: jest.fn().mockResolvedValue({}),
    }),
  };
  const cache = { get: jest.fn().mockResolvedValue(null) };
  const redisHealth = { isAvailable: jest.fn().mockReturnValue(true) };
  const svc = new MangaDexCoverService(
    queue as never,
    { get: jest.fn() } as never,
    cache as never,
    redisHealth as never,
  );
  // Court-circuite onModuleInit (connexion Redis réelle) : waitUntilFinished est mocké sur le job.
  (svc as unknown as { queueEvents: unknown }).queueEvents = {};
  return { svc, queue };
}

function priorityOf(queue: { add: jest.Mock }, jobName: string): unknown {
  const call = queue.add.mock.calls.find(([name]) => name === jobName);
  return (call?.[2] as { priority?: number } | undefined)?.priority;
}

describe('MangaDexCoverService — priorités de la file', () => {
  it('recherche, lecture par id et identification passent devant le réchauffage des jaquettes', async () => {
    const { svc, queue } = make();

    await svc.searchSeries('Frieren', 0, 20);
    await svc.fetchSeries('304ceac3-8cdb-4fe7-acf7-2b6ff7a60613');
    await svc.identifySeries('Sousou no Frieren', []);
    await svc.resolveSeriesCovers('Frieren', {
      mangaId: null,
      malId: '126287',
      authors: [],
    });

    expect(priorityOf(queue, MANGADEX_SEARCH_JOB)).toBe(
      MANGADEX_PRIORITY_INTERACTIVE,
    );
    expect(priorityOf(queue, MANGADEX_SERIES_JOB)).toBe(
      MANGADEX_PRIORITY_INTERACTIVE,
    );
    expect(priorityOf(queue, MANGADEX_IDENTIFY_JOB)).toBe(
      MANGADEX_PRIORITY_INTERACTIVE,
    );
    expect(priorityOf(queue, MANGADEX_COVERS_JOB)).toBe(
      MANGADEX_PRIORITY_BACKGROUND,
    );
    // Plus petit = plus prioritaire (BullMQ).
    expect(MANGADEX_PRIORITY_INTERACTIVE).toBeLessThan(
      MANGADEX_PRIORITY_BACKGROUND,
    );
  });
});
