import { titleLadder } from './title-ladder';

/** Préfixes produits, dans l'ordre d'interrogation. */
function prefixes(title: string): string[] {
  return titleLadder(title).map((s) => s.prefix);
}

/** N° de tome de l'échelon dont le préfixe est `prefix` (celui qui matcherait chez MangaDex). */
function volumeAt(title: string, prefix: string): number | null | undefined {
  return titleLadder(title).find((s) => s.prefix === prefix)?.volume;
}

describe('titleLadder', () => {
  it('commence toujours par le titre complet, sans n° de tome (rien n’a encore été retiré)', () => {
    const steps = titleLadder('Spy X Family Tome 16');
    expect(steps[0]).toEqual({
      prefix: 'Spy X Family Tome 16',
      volume: null,
      cut: 0,
    });
  });

  // Les titres réels relevés le 2026-08-23 sur les ISBN du corpus (cf. spec §7). Le préfixe attendu
  // est celui que MangaDex accepte ; le n° de tome, celui que la queue retirée porte.
  it.each([
    ['Spy X Family Tome 16', 'Spy X Family', 16],
    ['Blue Lock Tome 33', 'Blue Lock', 33],
    ['Chainsaw Man Tome 22', 'Chainsaw Man', 22],
    ['Jujutsu Kaisen Tome 9', 'Jujutsu Kaisen', 9],
    ['Kaiju n°8 Tome 16', 'Kaiju n°8', 16],
    ['Naruto Edition Hokage Tome 22', 'Naruto Edition Hokage', 22],
    ['My Hero Academia Tome 23', 'My Hero Academia', 23],
    ['Tokyo Revengers Tome 13', 'Tokyo Revengers', 13],
    ['Bleach Tome 67', 'Bleach', 67],
    ['Sentenced to be a Hero Tome 1', 'Sentenced to be a Hero', 1],
  ])('%s → produit « %s » avec le tome %i', (title, prefix, volume) => {
    expect(prefixes(title)).toContain(prefix);
    expect(volumeAt(title, prefix)).toBe(volume);
  });

  it('traverse le bruit après le n° de tome (5 tokens retirés, dans la limite des 6)', () => {
    const title = 'Chainsaw Man Tome 18 . Edition collector';
    const steps = titleLadder(title);
    const winner = steps.find((s) => s.prefix === 'Chainsaw Man');

    expect(winner).toBeDefined();
    // Le n° reste 18 : « Edition collector » ne porte aucun chiffre qui viendrait après.
    expect(winner!.volume).toBe(18);
    expect(winner!.cut).toBe(5);
    // Les échelons dont la queue n'a pas de chiffre ne sont jamais interrogés.
    expect(prefixes(title)).not.toContain('Chainsaw Man Tome 18 .');
    expect(prefixes(title)).not.toContain('Chainsaw Man Tome 18 . Edition');
  });

  it('ne tronque JAMAIS une queue sans chiffre — c’est le seul garde-fou, et il sauve « Instinct grégaire »', () => {
    // Sans lui, « Instinct » matcherait une série réellement nommée *Instinct*.
    expect(prefixes('Instinct grégaire')).toEqual(['Instinct grégaire']);
    expect(prefixes('Ryomen Sakuna')).toEqual(['Ryomen Sakuna']);
    expect(prefixes('Kaijû girl carameliser')).toEqual([
      'Kaijû girl carameliser',
    ]);
  });

  it('titre d’un seul token : un unique échelon, rien à retirer', () => {
    expect(titleLadder('Frieren')).toEqual([
      { prefix: 'Frieren', volume: null, cut: 0 },
    ]);
    expect(titleLadder('Berserk')).toEqual([
      { prefix: 'Berserk', volume: null, cut: 0 },
    ]);
    expect(titleLadder('Merci')).toEqual([
      { prefix: 'Merci', volume: null, cut: 0 },
    ]);
  });

  it('va du plus long au plus court, sans jamais descendre sous 4 caractères de préfixe', () => {
    const steps = titleLadder('Ito 12 3 4 5');
    const lengths = steps.map((s) => s.prefix.length);
    // Décroissance stricte : on ne remonte jamais l'échelle.
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
    expect(steps.every((s) => s.prefix.length >= 4 || s.cut === 0)).toBe(true);
  });

  it('borne la profondeur à 6 tokens retirés', () => {
    const title = 'a b c d e f g h 9';
    expect(
      Math.max(...titleLadder(title).map((s) => s.cut)),
    ).toBeLessThanOrEqual(6);
  });

  it('retire la ponctuation de bord laissée par la troncature', () => {
    expect(prefixes('Kaiju No. 8 - Tome 3')).toContain('Kaiju No. 8');
  });

  it('prend le DERNIER entier de la queue retirée', () => {
    // « Tome 18 . Edition collector » → 18 ; la queue s'étend vers la gauche, le dernier entier ne
    // bouge donc pas d'un échelon à l'autre.
    const steps = titleLadder('Chainsaw Man Tome 18 . Edition collector');
    const volumes = steps.filter((s) => s.volume != null).map((s) => s.volume);
    expect(new Set(volumes)).toEqual(new Set([18]));
  });

  it('titre vide ou blanc → aucun échelon', () => {
    expect(titleLadder('')).toEqual([]);
    expect(titleLadder('   ')).toEqual([]);
  });

  it('ne produit jamais deux fois le même préfixe', () => {
    const steps = titleLadder('One Piece Tome 112 .');
    const seen = steps.map((s) => s.prefix.toLowerCase());
    expect(new Set(seen).size).toBe(seen.length);
  });
});
