import { GoogleBooksCoverService } from './googlebooks.service';
import { GBOOKS_COVER_JOB } from './googlebooks.types';

function makeService() {
  const store = new Map<string, unknown>();
  const cache = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
  };
  const config = { get: jest.fn((_k: string, d: unknown) => d) };
  // Par défaut : Redis disponible — le test de circuit-breaker force `false`.
  const redisHealth = { isAvailable: jest.fn().mockReturnValue(true) };
  const waitUntilFinished = jest.fn();
  const queue = {
    add: jest.fn().mockResolvedValue({ waitUntilFinished }),
  };
  const svc = new GoogleBooksCoverService(
    queue as never,
    config as never,
    cache as never,
    redisHealth as never,
  );
  // Court-circuite onModuleInit() (qui ouvrirait une vraie connexion Redis) : la valeur exacte
  // de queueEvents est indifférente ici, waitUntilFinished est mocké sur le job.
  (svc as unknown as { queueEvents: unknown }).queueEvents = {};
  return { svc, cache, config, redisHealth, queue, waitUntilFinished, store };
}

describe('GoogleBooksCoverService (producteur)', () => {
  describe('resolveCoverAndDescription', () => {
    it('hit de cache → renvoie sans enfiler de job', async () => {
      const { svc, queue, store } = makeService();
      store.set('gbooks:cover:9782505011943', {
        url: 'https://c.jpg',
        description: 'cached',
      });

      expect(await svc.resolveCoverAndDescription('9782505011943')).toEqual({
        coverUrl: 'https://c.jpg',
        description: 'cached',
        // Entrée de cache sans `status` (pré-0.6.4) → ré-inféré `found` (url présente).
        status: 'found',
      });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('miss → enfile un job single-flight (jobId = clé de cache) et attend son résultat', async () => {
      const { svc, queue, waitUntilFinished } = makeService();
      waitUntilFinished.mockResolvedValue({
        coverUrl: 'https://img/c.jpg',
        description: 'Résumé',
        status: 'found',
      });

      const res = await svc.resolveCoverAndDescription('978-2-505-01194-3', {
        title: 'Jujutsu kaisen',
        volume: 6,
        edition: null,
      });

      expect(res).toEqual({
        coverUrl: 'https://img/c.jpg',
        description: 'Résumé',
        status: 'found',
      });
      expect(queue.add).toHaveBeenCalledWith(
        GBOOKS_COVER_JOB,
        {
          isbn: '9782505011943',
          hint: { title: 'Jujutsu kaisen', volume: 6, edition: null },
        },
        expect.objectContaining({ jobId: 'gbooks:cover:9782505011943' }),
      );
    });

    it('ISBN trop court → absent sans cache ni enqueue', async () => {
      const { svc, cache, queue } = makeService();
      expect(await svc.resolveCoverAndDescription('123')).toEqual({
        coverUrl: null,
        description: null,
        status: 'absent',
      });
      expect(cache.get).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('best-effort : un échec d’attente (Redis down / worker en échec) → unresolved, pas d’exception', async () => {
      const { svc, waitUntilFinished } = makeService();
      waitUntilFinished.mockRejectedValue(new Error('redis down'));
      expect(await svc.resolveCoverAndDescription('9782505011943')).toEqual({
        coverUrl: null,
        description: null,
        status: 'unresolved',
      });
    });

    it('best-effort : un échec d’enqueue → unresolved, pas d’exception', async () => {
      const { svc, queue } = makeService();
      queue.add.mockRejectedValue(new Error('redis down'));
      expect(await svc.resolveCoverAndDescription('9782505011943')).toEqual({
        coverUrl: null,
        description: null,
        status: 'unresolved',
      });
    });

    it('circuit-breaker : Redis indisponible → unresolved immédiat, aucun enqueue', async () => {
      const { svc, queue, redisHealth } = makeService();
      redisHealth.isAvailable.mockReturnValue(false);
      expect(await svc.resolveCoverAndDescription('9782505011943')).toEqual({
        coverUrl: null,
        description: null,
        status: 'unresolved',
      });
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('resolveCover', () => {
    it('ne renvoie que l’URL de jaquette', async () => {
      const { svc, waitUntilFinished } = makeService();
      waitUntilFinished.mockResolvedValue({
        coverUrl: 'https://img/c.jpg',
        description: 'x',
      });
      expect(await svc.resolveCover('9782505011943')).toBe('https://img/c.jpg');
    });
  });

  describe('cachedCover', () => {
    it('lit le cache sans jamais enfiler de job', async () => {
      const { svc, queue, store } = makeService();
      store.set('gbooks:cover:9782505011943', { url: 'https://c.jpg' });
      expect(await svc.cachedCover('978-2-505-01194-3')).toBe('https://c.jpg');
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('renvoie null sur miss de cache', async () => {
      const { svc } = makeService();
      expect(await svc.cachedCover('9782505011943')).toBeNull();
    });
  });

  describe('cachedCoverAndDescription', () => {
    it('lit jaquette + résumé du cache sans jamais enfiler de job', async () => {
      const { svc, queue, store } = makeService();
      store.set('gbooks:cover:9782505011943', {
        url: 'https://c.jpg',
        description: 'cached',
      });
      expect(await svc.cachedCoverAndDescription('978-2-505-01194-3')).toEqual({
        coverUrl: 'https://c.jpg',
        description: 'cached',
        status: 'found',
      });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('miss de cache → unresolved (pas encore résolu, jamais de réseau)', async () => {
      const { svc, queue } = makeService();
      expect(await svc.cachedCoverAndDescription('9782505011943')).toEqual({
        coverUrl: null,
        description: null,
        status: 'unresolved',
      });
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
