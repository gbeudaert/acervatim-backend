import { MangaDexResolver } from './mangadex.resolver';
import { BnfAuthor } from '../bnf/bnf.types';

function makeResolver() {
  const http = { request: jest.fn() };
  const resolver = new MangaDexResolver(http as never);
  return { resolver, http };
}

function ok(data: unknown) {
  return { status: 200, headers: {}, data };
}

/** Route les appels MangaDex de `identify` (manga / cover / statistics) par motif d'URL. */
function routeHttp(
  http: { request: jest.Mock },
  bodies: { manga: unknown; cover?: unknown; stats?: unknown },
) {
  http.request.mockImplementation((url: string) => {
    if (url.includes('/manga?')) return Promise.resolve(ok(bodies.manga));
    if (url.includes('/cover?'))
      return Promise.resolve(ok(bodies.cover ?? { data: [] }));
    if (url.includes('/statistics'))
      return Promise.resolve(ok(bodies.stats ?? { statistics: {} }));
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
}

const ISAYAMA: BnfAuthor[] = [
  { surname: 'Isayama', given: 'Hajime', full: 'Hajime Isayama' },
];

describe('MangaDexResolver.identify', () => {
  it('identifie un manga : lit links.mal/al, synopsis FR, jaquette, genres, note, jaquettes par tome', async () => {
    const { resolver, http } = makeResolver();
    routeHttp(http, {
      manga: {
        data: [
          {
            id: 'md-1',
            attributes: {
              title: { en: 'Shingeki no Kyojin' },
              altTitles: [
                { fr: "L'Attaque des Titans" },
                { 'ja-ro': 'Shingeki no Kyojin' },
              ],
              description: { fr: 'Synopsis FR.', en: 'EN synopsis.' },
              links: { mal: '23390', al: '53390' },
              status: 'completed',
              year: 2009,
              lastVolume: '34',
              contentRating: 'safe',
              tags: [
                { attributes: { group: 'genre', name: { en: 'Action' } } },
                { attributes: { group: 'theme', name: { en: 'Military' } } },
              ],
            },
            relationships: [
              { type: 'author', attributes: { name: 'Hajime Isayama' } },
              { type: 'cover_art', attributes: { fileName: 'cover.jpg' } },
            ],
          },
        ],
      },
      cover: {
        data: [
          { attributes: { volume: '1', fileName: 'v1.jpg', locale: 'fr' } },
        ],
      },
      stats: { statistics: { 'md-1': { rating: { bayesian: 8.4 } } } },
    });

    const identity = await resolver.identify('Shingeki no kyojin', ISAYAMA);

    expect(identity).not.toBeNull();
    expect(identity!.mangaId).toBe('md-1');
    expect(identity!.malId).toBe('23390');
    expect(identity!.anilistId).toBe('53390');
    expect(identity!.titleFr).toBe("L'Attaque des Titans");
    expect(identity!.title).toBe("L'Attaque des Titans"); // FR préféré à l'affichage
    expect(identity!.descriptionFr).toBe('Synopsis FR.');
    expect(identity!.descriptionEn).toBe('EN synopsis.');
    expect(identity!.coverUrl).toBe(
      'https://uploads.mangadex.org/covers/md-1/cover.jpg.512.jpg',
    );
    expect(identity!.genres).toEqual(['Action']); // seuls les tags group=genre
    expect(identity!.authors).toEqual(['Hajime Isayama']);
    expect(identity!.rating).toBe(8.4);
    expect(identity!.lastVolume).toBe('34');
    expect(identity!.volumes['1']).toEqual({
      url: 'https://uploads.mangadex.org/covers/md-1/v1.jpg.512.jpg',
      locale: 'fr',
    });
    expect(identity!.matchedBy).toBe('title+author');
  });

  it('désambiguïse les spin-offs du même auteur : préfère l’égalité exacte de titre (rang non prioritaire)', async () => {
    const { resolver, http } = makeResolver();
    routeHttp(http, {
      manga: {
        data: [
          // Rang 0 : spin-off (titre contient la requête mais ne l'égale pas).
          {
            id: 'spinoff',
            attributes: {
              title: { en: 'Jigokuraku: Kishiritsu' },
              links: {},
            },
            relationships: [
              { type: 'author', attributes: { name: 'Yuji Kaku' } },
            ],
          },
          // Rang 1 : série principale (titre exact).
          {
            id: 'main',
            attributes: { title: { en: 'Jigokuraku' }, links: { mal: '100' } },
            relationships: [
              { type: 'author', attributes: { name: 'Yuji Kaku' } },
            ],
          },
        ],
      },
    });

    const identity = await resolver.identify('Jigokuraku', [
      { surname: 'Kaku', given: 'Yuji', full: 'Yuji Kaku' },
    ]);

    expect(identity!.mangaId).toBe('main');
    expect(identity!.malId).toBe('100');
  });

  it('renvoie null si aucun candidat ne valide (auteur absent ET titre trop éloigné)', async () => {
    const { resolver, http } = makeResolver();
    routeHttp(http, {
      manga: {
        data: [
          {
            id: 'other',
            attributes: { title: { en: 'Totally Different Work' }, links: {} },
            relationships: [
              { type: 'author', attributes: { name: 'Someone Else' } },
            ],
          },
        ],
      },
    });

    const identity = await resolver.identify('Shingeki no kyojin', ISAYAMA);

    expect(identity).toBeNull();
    // Court-circuit : ni /cover ni /statistics appelés quand rien n'est retenu.
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it('accepte sur titre fort seul (sans auteur BnF exploitable)', async () => {
    const { resolver, http } = makeResolver();
    routeHttp(http, {
      manga: {
        data: [
          {
            id: 'op',
            attributes: { title: { en: 'One Piece' }, links: { mal: '13' } },
            relationships: [
              { type: 'author', attributes: { name: 'Eiichiro Oda' } },
            ],
          },
        ],
      },
    });

    const identity = await resolver.identify('One Piece', []);

    expect(identity!.mangaId).toBe('op');
    expect(identity!.matchedBy).toBe('title');
  });
});
