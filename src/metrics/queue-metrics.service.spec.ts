import { Logger } from '@nestjs/common';
import { QueueMetricsService } from './queue-metrics.service';

type CountFn = jest.Mock<Promise<Record<string, number>>, [...string[]]>;

function makeQueue(counts: Record<string, number>): { getJobCounts: CountFn } {
  return { getJobCounts: jest.fn().mockResolvedValue(counts) };
}

const ZERO = {
  waiting: 0,
  active: 0,
  delayed: 0,
  completed: 0,
  failed: 0,
};

function make(available = true) {
  const redisHealth = { isAvailable: jest.fn().mockReturnValue(available) };
  const queues = {
    gbooks: makeQueue(ZERO),
    bnf: makeQueue(ZERO),
    mal: makeQueue(ZERO),
    discogs: makeQueue(ZERO),
    tmdb: makeQueue(ZERO),
    editionImport: makeQueue(ZERO),
  };
  const svc = new QueueMetricsService(
    redisHealth as never,
    queues.gbooks as never,
    queues.bnf as never,
    queues.mal as never,
    queues.discogs as never,
    queues.tmdb as never,
    queues.editionImport as never,
  );
  return { svc, redisHealth, queues };
}

describe('QueueMetricsService', () => {
  describe('snapshot', () => {
    it('agrège les compteurs des 6 files (noms + valeurs normalisées)', async () => {
      const { svc, queues } = make();
      queues.gbooks.getJobCounts.mockResolvedValue({
        waiting: 3,
        active: 2,
        delayed: 1,
        completed: 10,
        failed: 0,
      });

      const snap = await svc.snapshot();

      expect(snap).toHaveLength(6);
      expect(snap.map((m) => m.name)).toEqual([
        'gbooks',
        'bnf',
        'mal',
        'discogs',
        'tmdb',
        'edition-import',
      ]);
      expect(snap[0]).toEqual({
        name: 'gbooks',
        waiting: 3,
        active: 2,
        delayed: 1,
        completed: 10,
        failed: 0,
      });
    });
  });

  describe('logMetrics', () => {
    it('Redis down → aucun sondage des files', async () => {
      const { svc, redisHealth, queues } = make(false);
      await svc.logMetrics();
      expect(redisHealth.isAvailable).toHaveBeenCalled();
      expect(queues.gbooks.getJobCounts).not.toHaveBeenCalled();
    });

    it('tout au repos → aucun log (pas de spam)', async () => {
      const { svc } = make(true);
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      await svc.logMetrics();
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it('activité (backlog) → logue uniquement les files concernées', async () => {
      const { svc, queues } = make(true);
      queues.mal.getJobCounts.mockResolvedValue({
        waiting: 5,
        active: 1,
        delayed: 0,
        completed: 2,
        failed: 0,
      });
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);

      await svc.logMetrics();

      expect(log).toHaveBeenCalledTimes(1);
      const line = log.mock.calls[0][0] as string;
      expect(line).toContain('mal[w5 a1 d0 f0 c2]');
      expect(line).not.toContain('gbooks'); // au repos → absent
      log.mockRestore();
    });
  });
});
