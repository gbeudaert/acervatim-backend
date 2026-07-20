import {
  isSpecialArtEdition,
  matchesAuthor,
  normName,
  nameTokens,
  titleSimilarity,
} from './manga-matching';
import { BnfAuthor } from './bnf/bnf.types';

describe('manga-matching — normName / nameTokens', () => {
  it('normName retire accents, casse et espaces de bord', () => {
    expect(normName('  Éd. Colossale ')).toBe('ed. colossale');
  });

  it('nameTokens découpe et écarte les tokens < 2 lettres', () => {
    expect(nameTokens('Hajime Isayama')).toEqual(['hajime', 'isayama']);
    expect(nameTokens('A B Toriyama')).toEqual(['toriyama']); // initiales seules écartées
    expect(nameTokens(undefined)).toEqual([]);
  });
});

describe('manga-matching — matchesAuthor', () => {
  const bnf: BnfAuthor[] = [
    { surname: 'Isayama', given: 'Hajime', full: 'Hajime Isayama' },
  ];

  it('vrai si un token de nom est commun (insensible casse/accents/ordre)', () => {
    expect(matchesAuthor(bnf, ['Hajime Isayama'])).toBe(true);
    expect(matchesAuthor(bnf, ['ISAYAMA', 'Hajime'])).toBe(true);
  });

  it('faux si aucun token commun', () => {
    expect(matchesAuthor(bnf, ['Eiichiro Oda'])).toBe(false);
  });

  it('faux sur listes vides / undefined', () => {
    expect(matchesAuthor([], ['Isayama'])).toBe(false);
    expect(matchesAuthor(bnf, [])).toBe(false);
    expect(matchesAuthor(bnf, [undefined, null])).toBe(false);
  });
});

describe('manga-matching — titleSimilarity', () => {
  it('contenance → 1.0 (requête incluse dans le candidat)', () => {
    expect(
      titleSimilarity('Tokyo toritsu', 'Jujutsu Kaisen 0: Tokyo Toritsu…'),
    ).toBe(1);
  });

  it('titres identiques (accents/casse ignorés) → 1.0', () => {
    expect(
      titleSimilarity("L'attaque des titans", "L'Attaque des Titans"),
    ).toBe(1);
  });

  it('titres disjoints → score bas', () => {
    expect(titleSimilarity('One Piece', 'Naruto')).toBeLessThan(0.3);
  });
});

describe('manga-matching — isSpecialArtEdition', () => {
  it('vrai pour les éditions d’art (visuel + numérotation distincts)', () => {
    for (const ed of [
      'Éd. colossale',
      'Perfect edition',
      'Kanzenban',
      'Éd. prestige',
      'deluxe',
      'Éd. luxe',
      'Collector',
      'Intégrale',
      'Coffret',
      'Grand format',
    ]) {
      expect(isSpecialArtEdition(ed)).toBe(true);
    }
  });

  it('faux pour null, standard et retirages (ordinaux — même visuel)', () => {
    expect(isSpecialArtEdition(null)).toBe(false);
    expect(isSpecialArtEdition(undefined)).toBe(false);
    // Retirages : art standard → NE PAS sauter MangaDex.
    expect(isSpecialArtEdition('Quatorzième éd.')).toBe(false);
    expect(isSpecialArtEdition('2e éd.')).toBe(false);
  });
});
