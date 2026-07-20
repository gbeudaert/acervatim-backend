import { ServiceUnavailableException } from '@nestjs/common';
import { EditionImportService } from './edition-import.service';
import { EDITION_IMPORT_JOB, editionImportJobId } from './edition-import.types';

function make() {
  const queue = {
    getJob: jest.fn(),
    add: jest.fn().mockResolvedValue(undefined),
  };
  const redisHealth = { isAvailable: jest.fn().mockReturnValue(true) };
  const svc = new EditionImportService(queue as never, redisHealth as never);
  return { svc, queue, redisHealth };
}

const TITLE = "L'attaque des titans";
const EDITION = 'Éd. colossale';

describe('EditionImportService', () => {
  describe('enqueue', () => {
    it('miss → enfile avec un jobId déterministe (dédup) et renvoie queued', async () => {
      const { svc, queue } = make();
      queue.getJob.mockResolvedValue(undefined);

      const res = await svc.enqueue(TITLE, EDITION);

      const expectedId = editionImportJobId(TITLE, EDITION);
      expect(res).toEqual({ jobId: expectedId, state: 'queued' });
      expect(queue.add).toHaveBeenCalledWith(
        EDITION_IMPORT_JOB,
        { title: TITLE, edition: EDITION, malId: null },
        expect.objectContaining({ jobId: expectedId }),
      );
    });

    it('deux demandes identiques → même jobId (dédup inter-user)', async () => {
      const { svc, queue } = make();
      queue.getJob.mockResolvedValue(undefined);
      const a = await svc.enqueue(TITLE, EDITION);
      const b = await svc.enqueue(`  ${TITLE.toUpperCase()} `, EDITION);
      expect(a.jobId).toBe(b.jobId); // normalisation (trim/casse/espaces)
    });

    it('job déjà actif → renvoyé tel quel, sans ré-enqueue', async () => {
      const { svc, queue } = make();
      queue.getJob.mockResolvedValue({ getState: async () => 'active' });

      const res = await svc.enqueue(TITLE, EDITION);

      expect(res.state).toBe('running');
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('job déjà complété → done, sans ré-enqueue (l’app re-tape edition-mapping)', async () => {
      const { svc, queue } = make();
      queue.getJob.mockResolvedValue({ getState: async () => 'completed' });

      const res = await svc.enqueue(TITLE);

      expect(res.state).toBe('done');
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('job précédent échoué → purgé puis ré-enfilé', async () => {
      const { svc, queue } = make();
      const remove = jest.fn().mockResolvedValue(undefined);
      queue.getJob.mockResolvedValue({
        getState: async () => 'failed',
        remove,
      });

      const res = await svc.enqueue(TITLE);

      expect(remove).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();
      expect(res.state).toBe('queued');
    });

    it('circuit-breaker : Redis indisponible → 503, aucun accès à la file', async () => {
      const { svc, queue, redisHealth } = make();
      redisHealth.isAvailable.mockReturnValue(false);

      await expect(svc.enqueue(TITLE, EDITION)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(queue.getJob).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('status', () => {
    it('id inconnu → null', async () => {
      const { svc, queue } = make();
      queue.getJob.mockResolvedValue(undefined);
      expect(await svc.status('nope')).toBeNull();
    });

    it('renvoie l’état projeté + la progression objet', async () => {
      const { svc, queue } = make();
      queue.getJob.mockResolvedValue({
        getState: async () => 'active',
        progress: { phase: 'covers', done: 3, total: 12 },
      });

      expect(await svc.status('abc')).toEqual({
        jobId: 'abc',
        state: 'running',
        progress: { phase: 'covers', done: 3, total: 12 },
      });
    });

    it('progression encore numérique (défaut BullMQ) → null', async () => {
      const { svc, queue } = make();
      queue.getJob.mockResolvedValue({
        getState: async () => 'waiting',
        progress: 0,
      });

      const res = await svc.status('abc');
      expect(res).toEqual({ jobId: 'abc', state: 'queued', progress: null });
    });
  });
});
