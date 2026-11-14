import {
  sakamotoRecords,
  sruResponse,
  unimarcRecord,
} from '../../../../test/fixtures/unimarc';
import {
  belongsToSeries,
  displayPublisher,
  inferredArtKeywords,
  matchesEdition,
  noticeCreationDate,
  normalizePublisher,
  readEditionRecord,
  volumeOf,
} from './edition-records';
import { parseUnimarc } from './unimarc.parser';

function read(xml: string) {
  return parseUnimarc(sruResponse([xml])).records.map(readEditionRecord)[0];
}

describe('normalizePublisher / displayPublisher', () => {
  it.each([
    ['Pika édition', 'pika', 'Pika'],
    ['Pika éd.', 'pika', 'Pika'],
    ['Pika', 'pika', 'Pika'],
    ['Pika roman', 'pika roman', 'Pika roman'],
    ['Éditions France loisirs', 'france loisirs', 'France loisirs'],
    ['Glénat', 'glenat', 'Glénat'],
    ['Ki-oon', 'ki oon', 'Ki-oon'],
  ])('%s → clé %s, libellé %s', (raw, key, label) => {
    expect(normalizePublisher(raw)).toBe(key);
    expect(displayPublisher(raw)).toBe(label);
  });

  it('absent → clé vide, libellé null', () => {
    expect(normalizePublisher(null)).toBe('');
    expect(displayPublisher(undefined)).toBeNull();
  });
});

describe('noticeCreationDate (100$a)', () => {
  it.each([
    ['20260728d2026    m  y0frey50      ba', '2026-07-28'],
    ['20191301d2019', null], // mois 13 : pas une date
    ['d2019', null],
    [undefined, null],
  ])('%s → %s', (raw, expected) => {
    expect(noticeCreationDate(raw)).toBe(expected);
  });
});

describe('readEditionRecord — pré-notice (Sakamoto Days T22)', () => {
  const [, prenotice] = sakamotoRecords();
  const r = read(prenotice);

  it("appartient à la série malgré 225$a = « Shonen manga » (collection de l'éditeur)", () => {
    // Sans 461, 225$a n'est qu'un des titres candidats : il ne masque plus 500$a/200$a.
    expect(r.collectionKey).toBe('shonen manga');
    expect(belongsToSeries(r, 'sakamoto days')).toBe(true);
  });

  it('lit le n° en 200$h (« vol. 22 ») et la date de création', () => {
    expect(volumeOf(r, 'sakamoto days')).toBe(22);
    expect(r.noticeCreatedAt).toBe('2026-07-28');
  });

  it("lit l'auteur en 702 et écarte le traducteur", () => {
    expect(r.authors).toEqual([
      { surname: 'Suzuki', given: 'Yūto', full: 'Yūto Suzuki' },
    ]);
  });
});

describe('volumeOf', () => {
  it("ne croit pas le $v d'une collection éditeur", () => {
    const r = read(
      unimarcRecord({
        title: 'Sakamoto days',
        collection: 'Shonen manga',
        collectionVolume: '123',
        volume: '5',
      }),
    );
    expect(volumeOf(r, 'sakamoto days')).toBe(5);
  });
});

describe('matchesEdition — pré-notice d’édition d’art sans 205', () => {
  const r = read(
    unimarcRecord({
      title: 'Hellsing perfect edition',
      volume: '5',
      uniform: 'Hellsing',
    }),
  );

  it("n'est pas rangée en standard", () => {
    expect(inferredArtKeywords(r, 'hellsing')).toEqual(['perfect']);
    expect(matchesEdition(r, '', null, 'hellsing')).toBe(false);
  });

  it("rejoint l'édition d'art qui partage le mot-clé", () => {
    expect(matchesEdition(r, 'perfect', 'Perfect edition', 'hellsing')).toBe(
      true,
    );
    expect(matchesEdition(r, 'colossale', 'Éd. colossale', 'hellsing')).toBe(
      false,
    );
  });
});

describe('inferredArtKeywords — les mots du titre de série ne comptent pas', () => {
  it('« Perfect World » sans 205 : aucun mot-clé, la standard reste standard', () => {
    const r = read(unimarcRecord({ title: 'Perfect World', volume: '3' }));
    expect(inferredArtKeywords(r, 'perfect world')).toEqual([]);
    expect(matchesEdition(r, '', null, 'perfect world')).toBe(true);
  });

  it('retrait en multi-ensemble : « Perfect World perfect edition » garde un perfect', () => {
    const r = read(
      unimarcRecord({ title: 'Perfect World perfect edition', volume: '1' }),
    );
    expect(inferredArtKeywords(r, 'perfect world')).toEqual(['perfect']);
  });

  it('une notice avec 205 ne déduit rien de son titre', () => {
    const r = read(
      unimarcRecord({
        title: 'Hellsing perfect edition',
        edition: 'Perfect edition',
      }),
    );
    expect(inferredArtKeywords(r, 'hellsing')).toEqual([]);
  });
});

describe('belongsToSeries', () => {
  it('461$t fait autorité : un 200$a identique ne suffit pas si l’ensemble diffère', () => {
    const r = read(
      unimarcRecord({ title: 'Naruto', set: 'Naruto : les romans' }),
    );
    expect(belongsToSeries(r, 'naruto')).toBe(false);
    expect(belongsToSeries(r, 'naruto les romans')).toBe(true);
  });

  it('sans 461 : 225$a = série reste membre malgré un 500$a japonais', () => {
    const r = read(
      unimarcRecord({
        title: 'Le chat porte-bonheur',
        collection: 'Le pacte des yôkai',
        uniform: 'Natsume yūjinchō',
      }),
    );
    expect(belongsToSeries(r, 'le pacte des yokai')).toBe(true);
  });

  it('pré-notice Sakamoto : 225$a « Shonen manga » ≠ clé, mais 500$a/200$a = clé', () => {
    const r = read(sakamotoRecords()[1]);
    expect(belongsToSeries(r, 'sakamoto days')).toBe(true);
  });
});
