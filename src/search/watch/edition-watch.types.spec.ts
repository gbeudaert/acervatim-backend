import {
  dedupeEditions,
  EditionWatchState,
  editionWatchKey,
  mergeWatchState,
  missingTomes,
  nextSince,
  readWatchableNode,
  sinceFor,
  toSruDate,
  WatchableNode,
} from './edition-watch.types';

const NOW = new Date('2026-11-02T04:00:00.000Z');
const COMPLETE = { since: '20261019', complete: true };

function node(over: Partial<WatchableNode> = {}): WatchableNode {
  return {
    title: 'Sakamoto days',
    publisherFr: 'Glénat',
    edition: null,
    mangaId: null,
    status: 'ongoing',
    ...over,
  };
}

describe('edition-watch — fonctions pures', () => {
  describe('sinceFor', () => {
    it('première vérification : maintenant − 60 jours, au format AAAAMMJJ', () => {
      expect(sinceFor(null, NOW)).toBe('20260903');
    });

    it('vérifications suivantes : dernière vérification − 7 jours (recouvrement)', () => {
      expect(sinceFor('2026-10-26T04:00:00.000Z', NOW)).toBe('20261019');
    });

    it('date de dernière vérification illisible : traitée comme une première fois', () => {
      expect(sinceFor('pas une date', NOW)).toBe('20260903');
    });

    it("jamais de tirets : `bib.creationdate` renvoie 0 notice en silence sur 'AAAA-MM-JJ'", () => {
      expect(toSruDate(NOW)).toMatch(/^\d{8}$/);
    });
  });

  describe('readWatchableNode', () => {
    it('lit titre, éditeur, édition, mangaId et statut du nœud', () => {
      expect(
        readWatchableNode({
          title: " L'attaque des titans ",
          publisherFr: 'Pika',
          edition: 'Éd. colossale',
          mangaId: 'md-1',
          status: 'ongoing',
          rating: 8,
        }),
      ).toEqual({
        title: "L'attaque des titans",
        publisherFr: 'Pika',
        edition: 'Éd. colossale',
        mangaId: 'md-1',
        status: 'ongoing',
      });
    });

    it("écarte un nœud sans éditeur : le titre seul ramènerait l'éditeur dominant", () => {
      expect(
        readWatchableNode({ title: 'Frieren', publisherFr: null }),
      ).toBeNull();
      expect(
        readWatchableNode({ title: 'Frieren', publisherFr: '  ' }),
      ).toBeNull();
    });

    it('écarte un nœud sans titre ou au unifiedData illisible', () => {
      expect(readWatchableNode({ publisherFr: 'Ki-oon' })).toBeNull();
      expect(readWatchableNode(null)).toBeNull();
      expect(readWatchableNode('texte')).toBeNull();
    });
  });

  describe('dedupeEditions', () => {
    it('une édition suivie par plusieurs nœuds = une seule requête', () => {
      const editions = dedupeEditions([
        node(),
        node({ title: 'SAKAMOTO DAYS', mangaId: 'md-sd' }),
        node({ publisherFr: 'Glénat éditions' }),
      ]);
      expect(editions).toHaveLength(1);
      expect(editions[0].nodeCount).toBe(3);
      // Le premier mangaId connu est retenu, même s'il arrive après un nœud qui n'en a pas.
      expect(editions[0].mangaId).toBe('md-sd');
    });

    it('Pika et France Loisirs, ou standard et colossale, restent deux éditions', () => {
      const editions = dedupeEditions([
        node({ title: "L'attaque des titans", publisherFr: 'Pika' }),
        node({ title: "L'attaque des titans", publisherFr: 'France loisirs' }),
        node({
          title: "L'attaque des titans",
          publisherFr: 'Pika édition',
          edition: 'Éd. colossale',
        }),
      ]);
      expect(editions).toHaveLength(3);
    });

    it('ignore les séries terminées', () => {
      expect(dedupeEditions([node({ status: 'finished' })])).toEqual([]);
    });
  });

  describe('editionWatchKey', () => {
    it('stable aux variantes d’écriture, distincte entre éditeurs', () => {
      expect(editionWatchKey('Sakamoto days', 'Glénat', null)).toBe(
        editionWatchKey('SAKAMOTO DAYS', 'Glenat éd.', ''),
      );
      expect(editionWatchKey("L'attaque des titans", 'Pika', null)).not.toBe(
        editionWatchKey("L'attaque des titans", 'France loisirs', null),
      );
      expect(editionWatchKey('x', 'y', null)).toMatch(
        /^edition-watch:v1:[0-9a-f]{40}$/,
      );
    });
  });

  describe('mergeWatchState', () => {
    const edition = {
      title: 'Sakamoto days',
      publisherFr: 'Glénat',
      edition: null,
    };
    const t22 = {
      isbn: '9782344068649',
      editionVolume: 22,
      titleFr: 'Sakamoto days',
      noticeCreatedAt: '2026-07-28',
      coverUrl: null,
    };

    it('premier passage : tout ce qui est trouvé est nouveau', () => {
      const { state, added } = mergeWatchState(
        null,
        edition,
        [t22],
        NOW,
        COMPLETE,
      );
      expect(added.map((t) => t.editionVolume)).toEqual([22]);
      expect(state.lastCheckedAt).toBe(NOW.toISOString());
      expect(state.tomes[0].detectedAt).toBe(NOW.toISOString());
    });

    it('le recouvrement ramène un tome connu : pas de doublon, jaquette complétée', () => {
      const previous: EditionWatchState = {
        ...edition,
        lastCheckedAt: '2026-10-26T04:00:00.000Z',
        tomes: [{ ...t22, detectedAt: '2026-10-26T04:00:00.000Z' }],
      };
      const { state, added } = mergeWatchState(
        previous,
        edition,
        [
          { ...t22, coverUrl: 'https://x/22.jpg' },
          {
            ...t22,
            editionVolume: 23,
            isbn: '978-23',
            noticeCreatedAt: '2026-10-30',
          },
        ],
        NOW,
        COMPLETE,
      );
      expect(added.map((t) => t.editionVolume)).toEqual([23]);
      expect(state.tomes.map((t) => t.editionVolume)).toEqual([22, 23]);
      expect(state.tomes[0].coverUrl).toBe('https://x/22.jpg');
      // La date de détection d'un tome déjà connu ne bouge pas (mesure du délai).
      expect(state.tomes[0].detectedAt).toBe('2026-10-26T04:00:00.000Z');
    });

    it('énumération incomplète : tomes gardés, lastCheckedAt inchangé, fenêtre mémorisée pour être rejouée', () => {
      const previous: EditionWatchState = {
        ...edition,
        lastCheckedAt: '2026-10-26T04:00:00.000Z',
        tomes: [],
      };
      const { state, added } = mergeWatchState(previous, edition, [t22], NOW, {
        since: '20261019',
        complete: false,
      });
      expect(added.map((t) => t.editionVolume)).toEqual([22]);
      expect(state.lastCheckedAt).toBe('2026-10-26T04:00:00.000Z');
      expect(state.retrySince).toBe('20261019');
      // Le passage suivant rejoue exactement la même fenêtre, quel que soit le jour où il tourne.
      expect(nextSince(state, new Date('2026-11-09T04:00:00.000Z'))).toBe(
        '20261019',
      );
    });

    it('premier passage incomplet : lastCheckedAt reste null, la fenêtre initiale est rejouée', () => {
      const { state } = mergeWatchState(null, edition, [], NOW, {
        since: '20260903',
        complete: false,
      });
      expect(state.lastCheckedAt).toBeNull();
      expect(nextSince(state, new Date('2026-11-09T04:00:00.000Z'))).toBe(
        '20260903',
      );
    });

    it('un passage complet efface la fenêtre en suspens', () => {
      const previous: EditionWatchState = {
        ...edition,
        lastCheckedAt: '2026-10-26T04:00:00.000Z',
        retrySince: '20261019',
        tomes: [],
      };
      const { state } = mergeWatchState(previous, edition, [], NOW, COMPLETE);
      expect(state.retrySince).toBeNull();
      expect(state.lastCheckedAt).toBe(NOW.toISOString());
      expect(nextSince(state, NOW)).toBe('20261026');
    });

    it('purge les tomes détectés il y a plus de 180 jours', () => {
      const previous: EditionWatchState = {
        ...edition,
        lastCheckedAt: '2026-10-26T04:00:00.000Z',
        tomes: [
          { ...t22, editionVolume: 3, detectedAt: '2026-01-01T00:00:00.000Z' },
        ],
      };
      const { state } = mergeWatchState(previous, edition, [], NOW, COMPLETE);
      expect(state.tomes).toEqual([]);
    });
  });

  describe('missingTomes', () => {
    const state: EditionWatchState = {
      title: 'Sakamoto days',
      publisherFr: 'Glénat',
      edition: null,
      lastCheckedAt: NOW.toISOString(),
      tomes: [21, 22, 23].map((v) => ({
        isbn: `978-${v}`,
        editionVolume: v,
        titleFr: 'Sakamoto days',
        noticeCreatedAt: '2026-10-01',
        coverUrl: null,
        detectedAt: NOW.toISOString(),
      })),
    };

    it('ne garde que les n° de tome absents des items du nœud, sans le champ interne detectedAt', () => {
      const missing = missingTomes(state, new Set([1, 2, 21]));
      expect(missing.map((t) => t.editionVolume)).toEqual([22, 23]);
      expect(missing[0]).toEqual({
        isbn: '978-22',
        editionVolume: 22,
        titleFr: 'Sakamoto days',
        noticeCreatedAt: '2026-10-01',
        coverUrl: null,
      });
    });

    it('aucun état (édition jamais vérifiée) : rien à proposer', () => {
      expect(missingTomes(null, new Set())).toEqual([]);
    });
  });
});
