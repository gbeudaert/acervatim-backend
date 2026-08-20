import { MangaItemSchema, MangaSerieSchema } from './manga';
import { VinylItemSchema, vinylProfile } from './vinyl';

describe('VinylItemSchema — champs ajoutés', () => {
  it('accepte recordingSpeed (enum) et country', () => {
    const parsed = VinylItemSchema.parse({
      type: 'vinyl',
      title: 'A',
      recordingSpeed: 'RPM_45',
      country: 'FR',
    });
    expect(parsed.recordingSpeed).toBe('RPM_45');
    expect(parsed.country).toBe('FR');
  });

  it('défaut null pour recordingSpeed/country quand absents', () => {
    const parsed = VinylItemSchema.parse({ type: 'vinyl', title: 'A' });
    expect(parsed.recordingSpeed).toBeNull();
    expect(parsed.country).toBeNull();
  });

  it('coerce coverUrl="" (client tolérant) en null', () => {
    const parsed = VinylItemSchema.parse({
      type: 'vinyl',
      title: 'A',
      coverUrl: '',
    });
    expect(parsed.coverUrl).toBeNull();
  });

  it('accepte une coverUrl valide et rejette une URL malformée', () => {
    expect(
      VinylItemSchema.parse({
        type: 'vinyl',
        title: 'A',
        coverUrl: 'https://example.test/c.jpg',
      }).coverUrl,
    ).toBe('https://example.test/c.jpg');
    expect(() =>
      VinylItemSchema.parse({
        type: 'vinyl',
        title: 'A',
        coverUrl: 'not-a-url',
      }),
    ).toThrow();
  });

  it('rejette une recordingSpeed inconnue', () => {
    expect(() =>
      VinylItemSchema.parse({
        type: 'vinyl',
        title: 'A',
        recordingSpeed: '33',
      }),
    ).toThrow();
  });

  it('retire barcode sans echouer : sources[] est la seule source de verite (S1bis)', () => {
    // Un client qui relit un item stocke avant S1bis et le repousse tel quel ne doit pas
    // se prendre un 400 sur une cle qu'il n'a pas produite.
    const parsed = VinylItemSchema.parse({
      type: 'vinyl',
      title: 'A',
      barcode: '0888072024557',
    });
    expect(parsed).not.toHaveProperty('barcode');
    expect(parsed.title).toBe('A');

    // Meme une valeur qui aurait ete invalide avant est simplement ignoree.
    expect(
      VinylItemSchema.parse({ type: 'vinyl', title: 'A', barcode: 'ABC-123' }),
    ).not.toHaveProperty('barcode');
  });

  it('rejette toujours une autre cle inconnue (.strict conserve)', () => {
    expect(() =>
      VinylItemSchema.parse({ type: 'vinyl', title: 'A', inconnu: 'x' }),
    ).toThrow();
  });
});

describe('vinylProfile.reconcileOnUpdate — anti-degradation de releaseDate', () => {
  const reconcile = (incoming: unknown, stored: unknown) =>
    vinylProfile.reconcileOnUpdate!(
      incoming as Record<string, unknown>,
      stored as Record<string, unknown>,
    );

  it('conserve la date precise face a un 1er janvier de la meme annee', () => {
    const out = reconcile(
      { title: 'A', releaseDate: '1959-01-01' },
      { title: 'A', releaseDate: '1959-08-17' },
    );
    expect(out.releaseDate).toBe('1959-08-17');
  });

  it('laisse passer un vrai changement d annee', () => {
    const out = reconcile(
      { releaseDate: '1960-01-01' },
      { releaseDate: '1959-08-17' },
    );
    expect(out.releaseDate).toBe('1960-01-01');
  });

  it('laisse passer une date entrante plus precise', () => {
    const out = reconcile(
      { releaseDate: '1959-08-17' },
      { releaseDate: '1959-01-01' },
    );
    expect(out.releaseDate).toBe('1959-08-17');
  });

  it('n interfere pas quand une des deux dates manque ou est nulle', () => {
    expect(reconcile({ releaseDate: '1959-01-01' }, {}).releaseDate).toBe(
      '1959-01-01',
    );
    expect(
      reconcile({ releaseDate: null }, { releaseDate: '1959-08-17' })
        .releaseDate,
    ).toBeNull();
  });

  it('ne touche a aucun autre champ', () => {
    const out = reconcile(
      { title: 'B', label: 'X', releaseDate: '1959-01-01' },
      { title: 'A', label: 'Y', releaseDate: '1959-08-17' },
    );
    expect(out).toEqual({ title: 'B', label: 'X', releaseDate: '1959-08-17' });
  });
});

describe('MangaItemSchema — champs ajoutés', () => {
  it('accepte publisherFr et pageCount', () => {
    const parsed = MangaItemSchema.parse({
      type: 'manga',
      publisherFr: 'Glénat',
      pageCount: 192,
    });
    expect(parsed.publisherFr).toBe('Glénat');
    expect(parsed.pageCount).toBe(192);
  });

  it('rejette un pageCount non positif', () => {
    expect(() =>
      MangaItemSchema.parse({ type: 'manga', pageCount: 0 }),
    ).toThrow();
  });
});

describe('MangaSerieSchema — demographic (niveau série)', () => {
  it('accepte une démographie connue', () => {
    const parsed = MangaSerieSchema.parse({
      title: 'X',
      demographic: 'seinen',
    });
    expect(parsed.demographic).toBe('seinen');
  });

  it('défaut null quand absente', () => {
    const parsed = MangaSerieSchema.parse({ title: 'X' });
    expect(parsed.demographic).toBeNull();
  });

  it('rejette une démographie inconnue', () => {
    expect(() =>
      MangaSerieSchema.parse({ title: 'X', demographic: 'isekai' }),
    ).toThrow();
  });
});
