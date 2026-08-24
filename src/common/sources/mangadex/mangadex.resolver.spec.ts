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

const ODA: BnfAuthor[] = [
  { surname: 'Oda', given: 'Eiichiro', full: 'Eiichiro Oda' },
];

describe('MangaDexResolver.identify — drapeau ambiguous', () => {
  /**
   * Entrée MangaDex minimale : titre EN + alt-titres (c'est par eux que la série FR est retrouvée —
   * « Boku no Hero Academia » porte l'alt-titre « My Hero Academia »), et des auteurs optionnels.
   */
  function entity(
    id: string,
    title: string,
    opts: { alt?: string[]; authors?: string[] } = {},
  ) {
    return {
      id,
      attributes: {
        title: { en: title },
        altTitles: (opts.alt ?? []).map((t) => ({ fr: t })),
        links: {},
      },
      relationships: (opts.authors ?? []).map((name) => ({
        type: 'author',
        attributes: { name },
      })),
    };
  }

  it('« Frieren » : deux candidats contiennent la requête → ambiguous, et le crossover ne passe pas devant', async () => {
    const { resolver, http } = makeResolver();
    // Relevé réel : la série s'appelle « Sousou no Frieren », aucun candidat n'égale « Frieren »,
    // et le crossover parasite est mieux classé. Les deux ont un titleScore de 1.00 (contenance).
    routeHttp(http, {
      manga: {
        data: [
          entity('md-crossover', 'Frieren Cinnamoroll Kamigata'),
          entity('md-frieren', 'Sousou no Frieren'),
        ],
      },
    });

    const identity = await resolver.identify('Frieren', []);

    expect(identity).not.toBeNull();
    expect(identity!.ambiguous).toBe(true);
    // Le repli Google Books refusera sur ce drapeau (aucun auteur pour arbitrer) : c'est ainsi que
    // « Frieren Cinnamoroll Kamigata » est écarté, sans toucher au seuil PIVOT_TITLE_STRONG.
    expect(identity!.matchedBy).toBe('title');
  });

  it('l’auteur redevient l’arbitre quand Google Books le fournit : la vraie série gagne, malgré l’ambiguïté', async () => {
    const { resolver, http } = makeResolver();
    routeHttp(http, {
      manga: {
        data: [
          entity('md-crossover', 'Frieren Cinnamoroll Kamigata'),
          entity('md-frieren', 'Sousou no Frieren', {
            authors: ['Kanehito Yamada'],
          }),
        ],
      },
    });

    const identity = await resolver.identify('Frieren', [
      { full: 'Kanehito Yamada' },
    ]);

    expect(identity!.mangaId).toBe('md-frieren');
    expect(identity!.matchedBy).toBe('title+author');
    // Le drapeau reste vrai (deux titres ex aequo) mais l'appelant ne s'en sert pas : l'auteur a tranché.
    expect(identity!.ambiguous).toBe(true);
  });

  // Pièges relevés le 2026-08-23 : le spin-off / l'édition colorisée CONTIENT la requête (score de
  // titre 1.00 comme la vraie série) et remonte devant elle. Seul le bonus d'égalité exacte départage
  // — la série principale, elle, porte le titre FR exact en titre ou en alt-titre.
  it.each([
    ['Naruto', 'Naruto', 'Naruto : Uzumaki Illegitimate', []],
    [
      'My hero academia',
      'Boku no Hero Academia',
      'Vigilante : My Hero Academia Illegals',
      ['My Hero Academia'],
    ],
    [
      'Tokyo Revengers',
      'Toukyou Revengers',
      'Tokyo Revengers : Baji Keisuke',
      ['Tokyo Revengers'],
    ],
    ['Bleach', 'Bleach', 'Bleach (Official Colored)', []],
  ])('« %s » retient %s, jamais %s', async (query, expected, decoy, alt) => {
    const { resolver, http } = makeResolver();
    // Le decoy est en tête de liste, comme chez MangaDex : c'est le bonus d'égalité exacte qui
    // départage, pas le rang.
    routeHttp(http, {
      manga: {
        data: [
          entity('md-decoy', decoy as string),
          entity('md-main', expected as string, { alt: alt as string[] }),
        ],
      },
    });

    const identity = await resolver.identify(query as string, []);

    expect(identity!.mangaId).toBe('md-main');
    // `title` est le titre d'affichage (FR préféré) : c'est l'identité retenue qui compte ici, pas
    // la langue affichée — d'où l'assertion sur `titleRomaji`, qui porte bien la série principale.
    expect(identity!.titleRomaji).toBe(expected);
    // Les deux candidats sont ex aequo sur le titre : sans auteur, le repli Google Books refuse.
    expect(identity!.ambiguous).toBe(true);
  });

  it('candidat unique (cas « Sentenced to be a Hero ») → pas d’ambiguïté, le repli peut accepter', async () => {
    const { resolver, http } = makeResolver();
    routeHttp(http, {
      manga: {
        data: [entity('md-hero', 'Yuusha-kei ni Shosu Sentenced to be a Hero')],
      },
    });

    const identity = await resolver.identify('Sentenced to be a Hero', []);

    expect(identity).not.toBeNull();
    expect(identity!.ambiguous).toBe(false);
  });
});

describe('MangaDexResolver.fetchSeriesCovers', () => {
  it('mangaId connu → jaquettes lues directement, SANS recherche par titre', async () => {
    const { resolver, http } = makeResolver();
    http.request.mockImplementation((url: string) => {
      if (url.includes('/cover?'))
        return Promise.resolve(
          ok({
            data: [
              { attributes: { volume: '1', fileName: 'v1.jpg', locale: 'fr' } },
            ],
          }),
        );
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const res = await resolver.fetchSeriesCovers('One piece', {
      mangaId: 'md-op',
      malId: null,
      authors: [],
    });

    expect(res.status).toBe('found');
    expect(res.mangaId).toBe('md-op');
    expect(res.volumes['1'].url).toContain('/covers/md-op/v1.jpg');
    // Aucun /manga? : on n'a PAS cherché par titre.
    expect(
      http.request.mock.calls.every(([u]) => !String(u).includes('/manga?')),
    ).toBe(true);
  });

  it('sans id → valide par auteur ET préfère l’entrée canonique (links.mal) à la variante colorisée', async () => {
    const { resolver, http } = makeResolver();
    http.request.mockImplementation((url: string) => {
      if (url.includes('/manga?'))
        return Promise.resolve(
          ok({
            data: [
              // Rang 0 : variante colorisée (même titre+auteur, PAS de links.mal).
              {
                id: 'op-colored',
                attributes: { title: { en: 'One Piece' }, links: {} },
                relationships: [
                  { type: 'author', attributes: { name: 'Eiichiro Oda' } },
                ],
              },
              // Rang 1 : œuvre canonique (links.mal présent).
              {
                id: 'op-canon',
                attributes: {
                  title: { en: 'One Piece' },
                  links: { mal: '13' },
                },
                relationships: [
                  { type: 'author', attributes: { name: 'Eiichiro Oda' } },
                ],
              },
            ],
          }),
        );
      if (url.includes('/cover?'))
        return Promise.resolve(
          ok({
            data: [
              { attributes: { volume: '1', fileName: 'c1.jpg', locale: 'fr' } },
            ],
          }),
        );
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const res = await resolver.fetchSeriesCovers('One piece', {
      mangaId: null,
      malId: null,
      authors: ODA,
    });

    expect(res.mangaId).toBe('op-canon'); // canonique préféré malgré le rang inférieur
  });

  it('sans id ni auteur exploitable (bnf_only) → absent → l’appelant replie sur l’ISBN', async () => {
    const { resolver, http } = makeResolver();
    http.request.mockImplementation((url: string) => {
      if (url.includes('/manga?'))
        return Promise.resolve(
          ok({
            data: [
              {
                id: 'op-colored',
                attributes: { title: { en: 'One Piece' }, links: {} },
                relationships: [
                  { type: 'author', attributes: { name: 'Eiichiro Oda' } },
                ],
              },
            ],
          }),
        );
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const res = await resolver.fetchSeriesCovers('One piece', {
      mangaId: null,
      malId: null,
      authors: [], // aucun auteur BnF → pas de validation possible
    });

    expect(res.status).toBe('absent');
    expect(res.mangaId).toBeNull();
  });
});
