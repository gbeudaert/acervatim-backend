import { z } from 'zod';
import {
  filterAll,
  filterIn,
  parseFilters,
  searchFilter,
} from './parse-filters';

describe('filterIn', () => {
  const schema = filterIn(['vinyl', 'manga', 'movie']);

  it('parse une CSV et renvoie { in: [...] }', () => {
    expect(schema.parse({ in: 'vinyl,manga' })).toEqual({
      in: ['vinyl', 'manga'],
    });
  });

  it('trim les espaces autour des valeurs', () => {
    expect(schema.parse({ in: ' vinyl , manga ' })).toEqual({
      in: ['vinyl', 'manga'],
    });
  });

  it('ignore les segments vides (virgules en bord)', () => {
    expect(schema.parse({ in: 'vinyl,,manga,' })).toEqual({
      in: ['vinyl', 'manga'],
    });
  });

  it('rejette une valeur hors whitelist', () => {
    expect(() => schema.parse({ in: 'vinyl,unknown' })).toThrow();
  });

  it('rejette une CSV vide (zéro valeur après parse)', () => {
    expect(() => schema.parse({ in: '' })).toThrow();
    expect(() => schema.parse({ in: ',,' })).toThrow();
  });

  it('rejette un opérateur inconnu (clé hors { in })', () => {
    expect(() => schema.parse({ all: 'vinyl' })).toThrow();
    expect(() => schema.parse({ in: 'vinyl', extra: 'x' })).toThrow();
  });
});

describe('filterAll', () => {
  const schema = filterAll(['jazz', 'blues', 'rock']);

  it('parse une CSV et renvoie { hasEvery: [...] }', () => {
    expect(schema.parse({ all: 'jazz,blues' })).toEqual({
      hasEvery: ['jazz', 'blues'],
    });
  });

  it('rejette une valeur hors whitelist', () => {
    expect(() => schema.parse({ all: 'jazz,techno' })).toThrow();
  });

  it('rejette une clé { in } pour un filterAll', () => {
    expect(() => schema.parse({ in: 'jazz' })).toThrow();
  });
});

describe('searchFilter', () => {
  const schema = searchFilter();

  it('parse [in] (CSV → string[], texte libre, pas de whitelist)', () => {
    expect(schema.parse({ in: 'holow,naruto' })).toEqual({
      in: ['holow', 'naruto'],
    });
  });

  it('parse [all] et accepte n’importe quel texte', () => {
    expect(schema.parse({ all: 'one piece' })).toEqual({ all: ['one piece'] });
  });

  it('accepte [in] et [all] simultanément', () => {
    expect(schema.parse({ in: 'a', all: 'b,c' })).toEqual({
      in: ['a'],
      all: ['b', 'c'],
    });
  });

  it('rejette un objet sans [in] ni [all]', () => {
    expect(() => schema.parse({})).toThrow();
  });

  it('rejette une clé inconnue (.strict)', () => {
    expect(() => schema.parse({ in: 'a', contains: 'b' })).toThrow();
  });

  it('rejette une CSV vide', () => {
    expect(() => schema.parse({ in: ',,' })).toThrow();
  });

  it('rejette au-delà de 10 termes', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `t${i}`).join(',');
    expect(() => schema.parse({ in: eleven })).toThrow();
  });
});

describe('parseFilters', () => {
  const QuerySchema = z
    .object({
      type: filterIn(['vinyl', 'manga']).optional(),
      tags: filterAll(['jazz', 'blues', 'rock']).optional(),
      limit: z.coerce.number().int().optional(),
    })
    .strict();

  it('valide et splat dans Prisma where', () => {
    const parsed = parseFilters(
      { type: { in: 'vinyl,manga' }, tags: { all: 'jazz,blues' } },
      QuerySchema,
    );

    expect(parsed.type).toEqual({ in: ['vinyl', 'manga'] });
    expect(parsed.tags).toEqual({ hasEvery: ['jazz', 'blues'] });
  });

  it('rejette une clé inconnue (.strict)', () => {
    expect(() =>
      parseFilters({ type: { in: 'vinyl' }, unknown: 'foo' }, QuerySchema),
    ).toThrow();
  });

  it('accepte un payload vide (tous filtres optionnels)', () => {
    expect(parseFilters({}, QuerySchema)).toEqual({});
  });
});
