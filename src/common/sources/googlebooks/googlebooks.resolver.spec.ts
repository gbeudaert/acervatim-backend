import { GoogleBooksResolver } from './googlebooks.resolver';

function makeResolver(opts?: { apiKey?: string }) {
  const http = { request: jest.fn() };
  const config = { get: jest.fn().mockReturnValue(opts?.apiKey) };
  const resolver = new GoogleBooksResolver(config as never, http as never);
  return { resolver, http, config };
}

function volumesResponse(
  imageLinks?: Record<string, string>,
  description?: string,
) {
  return {
    status: 200,
    headers: {},
    data: {
      items: [
        {
          volumeInfo: {
            ...(imageLinks ? { imageLinks } : {}),
            ...(description ? { description } : {}),
          },
        },
      ],
    },
  };
}

/** Une notice Google Books `intitle:` : titre, présence d'image, et n° de série structuré éventuel. */
type TitleEntry = {
  title: string;
  withImage?: boolean;
  /** `seriesInfo.bookDisplayNumber` — n° de tome structuré (prioritaire sur le titre). */
  displayNumber?: string;
};

/** Réponse Google Books `intitle:` à partir d'une liste de notices. */
function titleVolumesResponse(entries: TitleEntry[]) {
  return {
    status: 200,
    headers: {},
    data: {
      items: entries.map((e) => ({
        volumeInfo: {
          title: e.title,
          ...(e.displayNumber
            ? { seriesInfo: { bookDisplayNumber: e.displayNumber } }
            : {}),
          ...(e.withImage
            ? { imageLinks: { thumbnail: `https://img/${e.title}.jpg` } }
            : {}),
        },
      })),
    },
  };
}

/**
 * Route le mock http selon la requête : `isbn:` → notice papier sans image (déclenche le repli),
 * `intitle:` → la liste [entries] fournie. Reproduit le flux réel fetchCover(isbn, hint).
 */
function routeIsbnThenTitle(
  http: { request: jest.Mock },
  entries: TitleEntry[],
) {
  http.request.mockImplementation(async (url: string) => {
    if (url.includes('q=isbn')) return volumesResponse(); // papier: pas d'image
    return titleVolumesResponse(entries);
  });
}

describe('GoogleBooksResolver.fetchCover', () => {
  describe('résolution par ISBN', () => {
    it('résout par ISBN, force https, retire edge=curl', async () => {
      const { resolver, http } = makeResolver();
      http.request.mockResolvedValue(
        volumesResponse({
          thumbnail: 'http://books.google.com/books?id=x&edge=curl',
        }),
      );

      const res = await resolver.fetchCover('978-2-505-01194-3');

      expect(res.coverUrl).toBe('https://books.google.com/books?id=x');
      // ISBN normalisé (sans tirets) dans la requête.
      expect(http.request.mock.calls[0][0]).toContain('q=isbn%3A9782505011943');
    });

    it('utilise smallThumbnail en repli si pas de thumbnail', async () => {
      const { resolver, http } = makeResolver();
      http.request.mockResolvedValue(
        volumesResponse({ smallThumbnail: 'https://img/s.jpg' }),
      );
      expect((await resolver.fetchCover('9782505011943')).coverUrl).toBe(
        'https://img/s.jpg',
      );
    });

    it('renvoie coverUrl null quand aucune image (200 sans jaquette)', async () => {
      const { resolver, http } = makeResolver();
      http.request.mockResolvedValue(volumesResponse());
      const res = await resolver.fetchCover('9782505011943');
      expect(res).toEqual({ coverUrl: null, description: null });
    });

    it('propage l’échec réseau (pour empêcher toute mise en cache côté worker)', async () => {
      const { resolver, http } = makeResolver();
      http.request.mockRejectedValue(new Error('boom'));
      await expect(resolver.fetchCover('9782505011943')).rejects.toThrow(
        'boom',
      );
    });

    it('renvoie null pour un ISBN trop court, sans réseau', async () => {
      const { resolver, http } = makeResolver();
      const res = await resolver.fetchCover('123');
      expect(res).toEqual({ coverUrl: null, description: null });
      expect(http.request).not.toHaveBeenCalled();
    });

    it('ajoute la clé API à la requête quand configurée', async () => {
      const { resolver, http } = makeResolver({ apiKey: 'KEY123' });
      http.request.mockResolvedValue({
        status: 200,
        headers: {},
        data: { items: [] },
      });
      await resolver.fetchCover('9782505011943');
      expect(http.request.mock.calls[0][0]).toContain('key=KEY123');
    });

    it('renvoie la description du volume', async () => {
      const { resolver, http } = makeResolver();
      http.request.mockResolvedValue(
        volumesResponse({ thumbnail: 'https://img/c.jpg' }, 'Résumé du tome'),
      );
      expect(await resolver.fetchCover('9782505011943')).toEqual({
        coverUrl: 'https://img/c.jpg',
        description: 'Résumé du tome',
      });
    });
  });

  describe('repli par titre (hint BnF)', () => {
    const hint = (
      title: string,
      volume: number,
      edition: string | null = null,
    ) => ({ title, volume, edition });

    it('interroge le repli en T zéro-padté (T06) quand la notice ISBN n’a pas d’image', async () => {
      const { resolver, http } = makeResolver();
      routeIsbnThenTitle(http, [
        { title: 'Jujutsu Kaisen T06', withImage: true },
      ]);

      await resolver.fetchCover('9791032706343', hint('Jujutsu kaisen', 6));

      const titleCall = http.request.mock.calls.find(
        (c) => !String(c[0]).includes('q=isbn'),
      );
      expect(titleCall?.[0]).toContain('intitle');
      expect(titleCall?.[0]).toContain('T06');
    });

    it('retient le tome exact et écarte le light novel « Roman … » et les tomes voisins', async () => {
      const { resolver, http } = makeResolver();
      routeIsbnThenTitle(http, [
        { title: 'Roman Jujutsu Kaisen T01', withImage: true },
        { title: 'Jujutsu Kaisen T05', withImage: true },
        { title: 'Jujutsu Kaisen T06', withImage: true },
      ]);

      const res = await resolver.fetchCover(
        '9791032706343',
        hint('Jujutsu kaisen', 6),
      );
      expect(res.coverUrl).toBe('https://img/Jujutsu Kaisen T06.jpg');
    });

    it('édition Colossale : retient la jaquette Colossale, pas la standard ni le hors-série', async () => {
      const { resolver, http } = makeResolver();
      routeIsbnThenTitle(http, [
        { title: "L'Attaque des Titans T06", withImage: true }, // standard
        {
          title: "L'Attaque des Titans - Before the Fall Edition Colossale T06",
          withImage: true,
        },
        {
          title: "L'Attaque des Titans Edition Colossale T06",
          withImage: true,
        },
      ]);

      const res = await resolver.fetchCover(
        '9782811635923',
        hint("L'attaque des titans", 6, 'Éd. colossale'),
      );
      expect(res.coverUrl).toBe(
        "https://img/L'Attaque des Titans Edition Colossale T06.jpg",
      );
    });

    it('édition standard : retient la jaquette standard, jamais la Colossale', async () => {
      const { resolver, http } = makeResolver();
      routeIsbnThenTitle(http, [
        {
          title: "L'Attaque des Titans Edition Colossale T06",
          withImage: true,
        },
        { title: "L'Attaque des Titans T06", withImage: true }, // standard
      ]);

      const res = await resolver.fetchCover(
        '9782811620000',
        hint("L'attaque des titans", 6, null),
      );
      expect(res.coverUrl).toBe("https://img/L'Attaque des Titans T06.jpg");
    });

    it('renvoie null quand seule une édition étrangère/bare-number est illustrée (Black Torch)', async () => {
      const { resolver, http } = makeResolver();
      routeIsbnThenTitle(http, [
        { title: 'Black Torch 01' }, // FR sans image
        { title: 'BLACK TORCH 3', withImage: true }, // éd. japonaise, n° sans « T »
        { title: 'The Black Torch Anthology', withImage: true }, // hors-série
      ]);

      const res = await resolver.fetchCover(
        '9791032701881',
        hint('Black torch', 1),
      );
      expect(res.coverUrl).toBeNull();
    });

    it('appaire le tome via seriesInfo.bookDisplayNumber quand le titre ne porte pas de « T<n> »', async () => {
      const { resolver, http } = makeResolver();
      routeIsbnThenTitle(http, [
        // Titre sans jeton « T06 » : seul bookDisplayNumber donne le n° de tome.
        { title: 'Jujutsu Kaisen', withImage: true, displayNumber: '6' },
      ]);

      const res = await resolver.fetchCover(
        '9791032706343',
        hint('Jujutsu kaisen', 6),
      );
      expect(res.coverUrl).toBe('https://img/Jujutsu Kaisen.jpg');
    });

    it('préfère bookDisplayNumber au numéro du titre (tome fiable, édition par le titre)', async () => {
      const { resolver, http } = makeResolver();
      routeIsbnThenTitle(http, [
        // Titre « T05 » mais série indique le tome 6 → on suit seriesInfo, pas le titre.
        { title: 'Jujutsu Kaisen T05', withImage: true, displayNumber: '6' },
      ]);

      const res = await resolver.fetchCover(
        '9791032706343',
        hint('Jujutsu kaisen', 6),
      );
      expect(res.coverUrl).toBe('https://img/Jujutsu Kaisen T05.jpg');
    });

    it('ne tente pas le repli titre quand la notice ISBN a déjà une image', async () => {
      const { resolver, http } = makeResolver();
      http.request.mockResolvedValue(
        volumesResponse({ thumbnail: 'https://img/isbn.jpg' }),
      );

      const res = await resolver.fetchCover(
        '9791032706343',
        hint('Jujutsu kaisen', 6),
      );

      expect(res.coverUrl).toBe('https://img/isbn.jpg');
      expect(http.request).toHaveBeenCalledTimes(1); // isbn: seul, pas de intitle:
    });

    it('sans hint, aucun repli titre : reste sur la résolution par ISBN', async () => {
      const { resolver, http } = makeResolver();
      http.request.mockResolvedValue(volumesResponse()); // isbn: sans image
      expect((await resolver.fetchCover('9791032706343')).coverUrl).toBeNull();
      expect(http.request).toHaveBeenCalledTimes(1);
    });
  });
});
