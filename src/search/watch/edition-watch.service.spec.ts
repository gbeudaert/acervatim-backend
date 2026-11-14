import { ServiceUnavailableException } from '@nestjs/common';
import { EditionWatchService } from './edition-watch.service';
import {
  EDITION_WATCH_CRON,
  EDITION_WATCH_RUN_JOB,
  EDITION_WATCH_SCHEDULER_ID,
  EditionWatchState,
  editionWatchKey,
} from './edition-watch.types';

const NOW = new Date('2026-11-02T04:00:00.000Z');

type NodeRow = { id: string; userId: string; unifiedData: unknown };

function make(
  opts: {
    nodes?: NodeRow[];
    premium?: Record<string, boolean>;
    items?: { nodeId: string | null; volume: number | null }[];
    cache?: Record<string, unknown>;
    redis?: boolean;
  } = {},
) {
  const nodes = opts.nodes ?? [];
  const store = new Map<string, unknown>(Object.entries(opts.cache ?? {}));

  const prisma = {
    collectionNode: {
      // Pagination par curseur : on rejoue `take`/`cursor`/`skip` sur la liste ordonnée par id.
      findMany: jest.fn(
        (args: {
          where: { userId?: string };
          take?: number;
          cursor?: { id: string };
          skip?: number;
        }) => {
          let rows = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
          if (args.where.userId) {
            rows = rows.filter((n) => n.userId === args.where.userId);
          }
          if (args.cursor) {
            const i = rows.findIndex((n) => n.id === args.cursor!.id);
            rows = rows.slice(i + (args.skip ?? 0));
          }
          return Promise.resolve(args.take ? rows.slice(0, args.take) : rows);
        },
      ),
    },
    item: { findMany: jest.fn().mockResolvedValue(opts.items ?? []) },
  };
  const premium = {
    getStatus: jest.fn((userId: string) =>
      Promise.resolve({ isPremium: opts.premium?.[userId] ?? true }),
    ),
  };
  const search = { editionMapping: jest.fn() };
  const cache = {
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
  };
  const redisHealth = {
    isAvailable: jest.fn().mockReturnValue(opts.redis ?? true),
  };
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'manual-1' }),
    setGlobalConcurrency: jest.fn().mockResolvedValue(1),
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new EditionWatchService(
    prisma as never,
    premium as never,
    search as never,
    cache as never,
    redisHealth as never,
    queue as never,
  );
  return { svc, prisma, premium, search, cache, store, queue, redisHealth };
}

function serie(
  id: string,
  userId: string,
  unified: Record<string, unknown>,
): NodeRow {
  return { id, userId, unifiedData: { status: 'ongoing', ...unified } };
}

const SD = { title: 'Sakamoto days', publisherFr: 'Glénat' };

function tome(v: number, created = '2026-10-20') {
  return {
    isbn: `978-${v}`,
    editionVolume: v,
    titleFr: 'Sakamoto days',
    noticeCreatedAt: created,
    coverUrl: null,
    sourceVolumeRange: null,
    description: null,
    coverStatus: 'unresolved',
    coverSource: null,
  };
}

describe('EditionWatchService', () => {
  describe('selectWatchedEditions', () => {
    it('ne retient que les nœuds de propriétaires premium, et dédupe par édition', async () => {
      const { svc, premium } = make({
        nodes: [
          serie('n1', 'u-premium', SD),
          serie('n2', 'u-premium-2', { ...SD, title: 'SAKAMOTO DAYS' }),
          serie('n3', 'u-gratuit', { title: 'Frieren', publisherFr: 'Ki-oon' }),
          serie('n4', 'u-premium', { title: 'Sans éditeur' }),
          serie('n5', 'u-premium', {
            ...SD,
            title: 'Fini',
            status: 'finished',
          }),
        ],
        premium: { 'u-premium': true, 'u-premium-2': true, 'u-gratuit': false },
      });

      const editions = await svc.selectWatchedEditions();

      expect(editions.map((e) => e.title)).toEqual(['Sakamoto days']);
      expect(editions[0].nodeCount).toBe(2);
      // Statut premium lu une fois par utilisateur, pas une fois par nœud.
      expect(premium.getStatus).toHaveBeenCalledTimes(3);
    });

    it('parcourt tous les nœuds page par page', async () => {
      const nodes = Array.from({ length: 1201 }, (_, i) =>
        serie(`n${String(i).padStart(5, '0')}`, 'u', {
          title: `Série ${i}`,
          publisherFr: 'Pika',
        }),
      );
      const { svc, prisma } = make({ nodes });

      const editions = await svc.selectWatchedEditions();

      expect(editions).toHaveLength(1201);
      expect(prisma.collectionNode.findMany).toHaveBeenCalledTimes(3);
    });
  });

  describe('checkEdition / runOnce', () => {
    it("première vérification : énumère depuis 60 jours avec l'éditeur du nœud, puis enregistre l'état", async () => {
      const { svc, search, store } = make({
        nodes: [serie('n1', 'u', { ...SD, mangaId: 'md-sd' })],
      });
      search.editionMapping.mockResolvedValue({
        tomes: [tome(22), tome(23)],
        complete: true,
      });

      const res = await svc.runOnce(NOW);

      expect(res).toEqual({
        editions: 1,
        checked: 1,
        failed: 0,
        incomplete: 0,
        newTomes: 2,
      });
      expect(search.editionMapping).toHaveBeenCalledWith(
        'Sakamoto days',
        undefined,
        undefined,
        'md-sd',
        { publisher: 'Glénat', since: '20260903' },
      );
      const state = store.get(
        editionWatchKey('Sakamoto days', 'Glénat', null),
      ) as EditionWatchState;
      expect(state.lastCheckedAt).toBe(NOW.toISOString());
      expect(state.tomes.map((t) => t.editionVolume)).toEqual([22, 23]);
    });

    it('vérification suivante : since = dernière vérification − 7 jours', async () => {
      const key = editionWatchKey('Sakamoto days', 'Glénat', null);
      const { svc, search } = make({
        nodes: [serie('n1', 'u', SD)],
        cache: {
          [key]: {
            ...SD,
            edition: null,
            lastCheckedAt: '2026-10-26T04:00:00.000Z',
            tomes: [],
          },
        },
      });
      search.editionMapping.mockResolvedValue({ tomes: [], complete: true });

      await svc.runOnce(NOW);

      expect(search.editionMapping.mock.calls[0][4]).toEqual({
        publisher: 'Glénat',
        since: '20261019',
      });
    });

    it('énumération incomplète : tomes gardés, lastCheckedAt inchangé, même fenêtre au passage suivant', async () => {
      const key = editionWatchKey('Sakamoto days', 'Glénat', null);
      const { svc, search, store } = make({
        nodes: [serie('n1', 'u', SD)],
        cache: {
          [key]: {
            ...SD,
            edition: null,
            lastCheckedAt: '2026-10-26T04:00:00.000Z',
            tomes: [],
          },
        },
      });
      // Une page SRU en échec : la BnF rend ce qu'elle a lu, marqué incomplet, sans exception.
      search.editionMapping
        .mockResolvedValueOnce({ tomes: [tome(22)], complete: false })
        .mockResolvedValueOnce({ tomes: [tome(22), tome(23)], complete: true });

      const first = await svc.runOnce(NOW);

      expect(first).toEqual({
        editions: 1,
        checked: 1,
        failed: 0,
        incomplete: 1,
        newTomes: 1,
      });
      const afterFirst = store.get(key) as EditionWatchState;
      expect(afterFirst.lastCheckedAt).toBe('2026-10-26T04:00:00.000Z');
      expect(afterFirst.tomes.map((t) => t.editionVolume)).toEqual([22]);

      // Une semaine plus tard : la fenêtre rejouée est celle du passage incomplet, pas une nouvelle.
      const later = new Date('2026-11-09T04:00:00.000Z');
      const second = await svc.runOnce(later);

      expect(search.editionMapping.mock.calls[0][4].since).toBe('20261019');
      expect(search.editionMapping.mock.calls[1][4].since).toBe('20261019');
      expect(second.newTomes).toBe(1); // T23 seul : T22 était déjà retenu
      const afterSecond = store.get(key) as EditionWatchState;
      expect(afterSecond.lastCheckedAt).toBe(later.toISOString());
      expect(afterSecond.retrySince).toBeNull();
    });

    it("un échec sur une édition n'arrête pas les autres et ne réécrit pas son état", async () => {
      const { svc, search, cache } = make({
        nodes: [
          serie('n1', 'u', SD),
          serie('n2', 'u', { title: 'Frieren', publisherFr: 'Ki-oon' }),
        ],
      });
      search.editionMapping
        .mockRejectedValueOnce(new Error('bnf down'))
        .mockResolvedValueOnce({ tomes: [tome(15)], complete: true });

      const res = await svc.runOnce(NOW);

      expect(res).toEqual({
        editions: 2,
        checked: 1,
        failed: 1,
        incomplete: 0,
        newTomes: 1,
      });
      expect(cache.set).toHaveBeenCalledTimes(1);
    });
  });

  describe('seriesUpdates', () => {
    it("propose, par nœud, les tomes détectés que l'utilisateur n'a pas", async () => {
      const key = editionWatchKey('Sakamoto days', 'Glénat', null);
      const { svc, prisma } = make({
        nodes: [
          serie('n1', 'u1', SD),
          serie('n2', 'u1', { title: 'Frieren', publisherFr: 'Ki-oon' }),
          serie('n3', 'u1', { title: 'Sans éditeur' }),
          serie('n9', 'autre', SD),
        ],
        items: [
          { nodeId: 'n1', volume: 21 },
          { nodeId: 'n1', volume: 22 },
        ],
        cache: {
          [key]: {
            ...SD,
            edition: null,
            lastCheckedAt: NOW.toISOString(),
            tomes: [22, 23].map((v) => ({
              ...tome(v),
              detectedAt: NOW.toISOString(),
            })),
          },
        },
      });

      const res = await svc.seriesUpdates('u1');

      expect(res).toEqual({
        updates: [
          {
            nodeId: 'n1',
            title: 'Sakamoto days',
            edition: null,
            publisherFr: 'Glénat',
            newTomes: [
              {
                isbn: '978-23',
                editionVolume: 23,
                titleFr: 'Sakamoto days',
                noticeCreatedAt: '2026-10-20',
                coverUrl: null,
              },
            ],
          },
        ],
      });
      // Les items ne sont lus que pour les nœuds suivables de cet utilisateur.
      expect(prisma.item.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'u1',
            nodeId: { in: ['n1', 'n2'] },
          }),
        }),
      );
    });

    it('aucune série suivable : aucune lecture des items', async () => {
      const { svc, prisma } = make({
        nodes: [serie('n3', 'u1', { title: 'X' })],
      });
      expect(await svc.seriesUpdates('u1')).toEqual({ updates: [] });
      expect(prisma.item.findMany).not.toHaveBeenCalled();
    });
  });

  describe('planification et déclenchement manuel', () => {
    it('pose un planificateur hebdomadaire unique, concurrence globale 1', async () => {
      const { svc, queue } = make();
      await svc.ensureSchedule();
      expect(queue.setGlobalConcurrency).toHaveBeenCalledWith(1);
      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
        EDITION_WATCH_SCHEDULER_ID,
        { pattern: EDITION_WATCH_CRON },
        expect.objectContaining({ name: EDITION_WATCH_RUN_JOB }),
      );
    });

    it('déclenchement manuel : enfile un passage', async () => {
      const { svc, queue } = make();
      expect(await svc.enqueueManualRun()).toEqual({ jobId: 'manual-1' });
      expect(queue.add).toHaveBeenCalledWith(
        EDITION_WATCH_RUN_JOB,
        {},
        expect.objectContaining({
          jobId: expect.stringMatching(/^manual-\d+$/),
        }),
      );
    });

    it('Redis indisponible : 503 immédiat plutôt que de bloquer', async () => {
      const { svc, queue } = make({ redis: false });
      await expect(svc.enqueueManualRun()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
