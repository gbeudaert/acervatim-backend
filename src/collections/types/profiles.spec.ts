import { MangaItemSchema, MangaSerieSchema } from './manga';
import { VinylItemSchema } from './vinyl';

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

  it('rejette une recordingSpeed inconnue', () => {
    expect(() =>
      VinylItemSchema.parse({
        type: 'vinyl',
        title: 'A',
        recordingSpeed: '33',
      }),
    ).toThrow();
  });

  it('accepte un barcode digits-only et défaut null si absent', () => {
    const parsed = VinylItemSchema.parse({
      type: 'vinyl',
      title: 'A',
      barcode: '0888072024557',
    });
    expect(parsed.barcode).toBe('0888072024557');
    expect(
      VinylItemSchema.parse({ type: 'vinyl', title: 'A' }).barcode,
    ).toBeNull();
  });

  it('rejette un barcode non numerique', () => {
    expect(() =>
      VinylItemSchema.parse({ type: 'vinyl', title: 'A', barcode: 'ABC-123' }),
    ).toThrow();
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
