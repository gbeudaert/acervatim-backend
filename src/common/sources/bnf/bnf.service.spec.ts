import {
  sakamotoRecords,
  snkRecords,
  sruResponse,
  unimarcRecord,
} from '../../../../test/fixtures/unimarc';
import { BadGatewayException } from '@nestjs/common';
import { BnfService } from './bnf.service';

const COLOSSALE_XML = `<srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
  <srw:numberOfRecords>1</srw:numberOfRecords>
  <srw:records><srw:record><srw:recordData>
    <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
      <mxc:controlfield tag="003">http://catalogue.bnf.fr/ark:/12148/cb44459249t</mxc:controlfield>
      <mxc:datafield tag="200" ind1="1" ind2=" ">
        <mxc:subfield code="a">L'attaque des titans</mxc:subfield>
        <mxc:subfield code="h">1</mxc:subfield>
        <mxc:subfield code="f">Hajime Isayama</mxc:subfield>
      </mxc:datafield>
      <mxc:datafield tag="205" ind1=" " ind2=" "><mxc:subfield code="a">Éd. colossale</mxc:subfield></mxc:datafield>
      <mxc:datafield tag="210" ind1=" " ind2=" ">
        <mxc:subfield code="c">Pika édition</mxc:subfield>
        <mxc:subfield code="d">DL 2015</mxc:subfield>
      </mxc:datafield>
      <mxc:datafield tag="330" ind1=" " ind2=" "><mxc:subfield code="a">Dans un monde ravagé par les Titans, l'humanité se réfugie derrière de gigantesques murs.</mxc:subfield></mxc:datafield>
      <mxc:datafield tag="454" ind1=" " ind2="1">
        <mxc:subfield code="t">Shingeki no kyojin</mxc:subfield>
        <mxc:subfield code="h">vol. 1-3</mxc:subfield>
      </mxc:datafield>
      <mxc:datafield tag="700" ind1=" " ind2="1">
        <mxc:subfield code="a">Isayama</mxc:subfield>
        <mxc:subfield code="b">Hajime</mxc:subfield>
      </mxc:datafield>
    </mxc:record>
  </srw:recordData></srw:record></srw:records>
</srw:searchRetrieveResponse>`;

function makeService(xml: string) {
  const cache = {
    // Cache toujours froid en test : `get` rate, `set` enregistre le TTL choisi (on assert dessus).
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    // Chemin édition : exécute simplement le fetcher (pas de cache en test).
    getOrFetch: jest.fn(
      (_k: string, _ttl: number, fetcher: () => Promise<unknown>) => fetcher(),
    ),
  };
  // La file renvoie le XML via un job dont waitUntilFinished résout la valeur du worker.
  const queue = {
    add: jest.fn().mockResolvedValue({ waitUntilFinished: async () => xml }),
  };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const svc = new BnfService(config as never, cache as never, queue as never);
  // Court-circuite onModuleInit() (qui ouvrirait une vraie connexion Redis) : baseUrl garde son
  // défaut, la valeur de queueEvents est indifférente (waitUntilFinished est mocké sur le job).
  (svc as unknown as { queueEvents: unknown }).queueEvents = {};
  return { svc, queue, cache };
}

describe('BnfService', () => {
  it('extrait le titre original (454$t), la plage 454$h et l’auteur', async () => {
    const { svc } = makeService(COLOSSALE_XML);
    const res = await svc.resolveByIsbn('978-2-8116-2325-8');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const n = res.notice;
    expect(n.isbn).toBe('9782811623258');
    expect(n.originalTitle).toBe('Shingeki no kyojin');
    expect(n.originalTitleSource).toBe('454$t');
    expect(n.sourceVolumeRange).toBe('1-3');
    expect(n.noteFr).toContain('Titans'); // 330$a — note de résumé FR
    expect(n.edition).toBe('Éd. colossale');
    expect(n.publisherFr).toBe('Pika édition');
    expect(n.volume).toBe('1');
    expect(n.authors[0]).toMatchObject({ surname: 'Isayama', given: 'Hajime' });
    expect(n.ark).toContain('ark:/12148');
  });

  it('renvoie bnf_not_found sur 0 notice, et ne cache l’absence que 24 h', async () => {
    const { svc, cache } = makeService(
      `<srw:searchRetrieveResponse xmlns:srw="x"><srw:numberOfRecords>0</srw:numberOfRecords></srw:searchRetrieveResponse>`,
    );
    const res = await svc.resolveByIsbn('0000000000000');
    expect(res).toEqual({ ok: false, reason: 'bnf_not_found' });

    // Une absence n'est pas immuable (catalogage BnF en retard, éditeur belge/suisse) : la garder
    // 30 j comme une notice gèlerait le scan un mois après l'entrée réelle au catalogue.
    expect(cache.set).toHaveBeenCalledWith(
      'bnf:isbn:0000000000000',
      expect.any(String),
      24 * 3600,
    );
  });

  it('cache la notice trouvée 30 j', async () => {
    const { svc, cache } = makeService(COLOSSALE_XML);
    await svc.resolveByIsbn('9782811623258');
    expect(cache.set).toHaveBeenCalledWith(
      'bnf:isbn:9782811623258',
      expect.any(String),
      30 * 24 * 3600,
    );
  });

  it('sert le XML caché sans rappeler le SRU', async () => {
    const { svc, queue, cache } = makeService(COLOSSALE_XML);
    cache.get.mockResolvedValueOnce(COLOSSALE_XML);

    const res = await svc.resolveByIsbn('9782811623258');

    expect(res.ok).toBe(true);
    expect(queue.add).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled(); // pas de ré-écriture qui prolongerait le TTL
  });

  it('ne cache pas une réponse illisible (incident BnF transitoire)', async () => {
    const { svc, cache } = makeService('<html>503 Service Unavailable</html>');
    const res = await svc.resolveByIsbn('9782811623258');
    expect(res).toEqual({ ok: false, reason: 'bnf_unparsable' });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('renvoie bnf_unavailable quand le fetch via la file échoue (Redis down / worker)', async () => {
    const { svc, queue } = makeService(COLOSSALE_XML);
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    const res = await svc.resolveByIsbn('9782811623258');
    expect(res).toEqual({ ok: false, reason: 'bnf_unavailable' });
  });

  it('détecte une série en cours sur date ouverte (210$d "2015-")', async () => {
    const xml = COLOSSALE_XML.replace('DL 2015', '2015-');
    const { svc } = makeService(xml);
    const res = await svc.resolveByIsbn('9782811623258');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.notice.ongoing).toBe(true);
  });

  it('énumère une édition : filtre 205, dédup par tome, dérive le compte', async () => {
    const rec = (
      vol: string,
      ed205: string | null,
      h454: string | null,
      isbn: string,
    ) => `<srw:record><srw:recordData>
      <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
        <mxc:datafield tag="010" ind1=" " ind2=" "><mxc:subfield code="a">${isbn}</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="200" ind1="1" ind2=" ">
          <mxc:subfield code="a">L'attaque des titans</mxc:subfield>
          <mxc:subfield code="h">${vol}</mxc:subfield>
        </mxc:datafield>
        ${ed205 ? `<mxc:datafield tag="205" ind1=" " ind2=" "><mxc:subfield code="a">${ed205}</mxc:subfield></mxc:datafield>` : ''}
        ${h454 ? `<mxc:datafield tag="454" ind1=" " ind2="1"><mxc:subfield code="t">Shingeki no kyojin</mxc:subfield><mxc:subfield code="h">${h454}</mxc:subfield></mxc:datafield>` : ''}
      </mxc:record></srw:recordData></srw:record>`;

    const guide = `<srw:record><srw:recordData>
      <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
        <mxc:datafield tag="200" ind1="1" ind2=" "><mxc:subfield code="a">L'attaque des titans : guide officiel</mxc:subfield></mxc:datafield>
      </mxc:record></srw:recordData></srw:record>`;

    const xml = `<srw:searchRetrieveResponse xmlns:srw="x">
      <srw:numberOfRecords>5</srw:numberOfRecords>
      <srw:records>
        ${rec('1', 'Éd. colossale', 'vol. 1-3', '978-1')}
        ${rec('2', 'Éd. colossale', 'vol. 4-6', '978-2')}
        ${rec('2', 'Éd. colossale', 'vol. 4-6', '978-2bis')}
        ${rec('1', null, null, '978-std')}
        ${guide}
      </srw:records></srw:searchRetrieveResponse>`;

    const { svc } = makeService(xml);
    const mapping = await svc.enumerateEdition(
      "L'attaque des titans",
      'Éd. colossale',
    );

    expect(mapping.tomeCount).toBe(2); // T.1 + T.2 (dédup), std + guide exclus
    expect(mapping.tomes.map((t) => t.editionVolume)).toEqual([1, 2]);
    expect(mapping.tomes[0]).toMatchObject({
      editionVolume: 1,
      sourceVolumeRange: '1-3',
      isbn: '978-1',
    });
    expect(mapping.tomes[1].sourceVolumeRange).toBe('4-6');
  });

  it('énumère un catalogage Ki-oon : série en 461$t, n° en 225$v, 200$a = titre de tome', async () => {
    // Chaque tome a un TITRE PROPRE en 200$a (pas le titre de série) et AUCUN 200$h ;
    // le n° est en 225$v et la série en 225$a/461$t. Cf. Jujutsu kaisen (Ki-oon).
    const tome = (
      title: string,
      vol: string,
      isbn: string,
    ) => `<srw:record><srw:recordData>
      <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
        <mxc:datafield tag="010" ind1=" " ind2=" "><mxc:subfield code="a">${isbn}</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="200" ind1="1" ind2=" "><mxc:subfield code="a">${title}</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="225" ind1="1" ind2="9"><mxc:subfield code="a">Jujutsu kaisen</mxc:subfield><mxc:subfield code="v">${vol}</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="461" ind1=" " ind2="0"><mxc:subfield code="t">Jujutsu kaisen</mxc:subfield><mxc:subfield code="v">${parseInt(vol, 10)}</mxc:subfield></mxc:datafield>
      </mxc:record></srw:recordData></srw:record>`;

    // Bruit : notice d'ensemble (pas de n°) + one-shot séparé "Jujutsu Kaisen 0".
    const ensemble = `<srw:record><srw:recordData><mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
      <mxc:datafield tag="200" ind1="1" ind2=" "><mxc:subfield code="a">Jujutsu kaisen</mxc:subfield></mxc:datafield>
      </mxc:record></srw:recordData></srw:record>`;
    const zero = `<srw:record><srw:recordData><mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
      <mxc:datafield tag="200" ind1="1" ind2=" "><mxc:subfield code="a">Jujutsu Kaisen 0</mxc:subfield></mxc:datafield>
      </mxc:record></srw:recordData></srw:record>`;

    const xml = `<srw:searchRetrieveResponse xmlns:srw="x">
      <srw:numberOfRecords>5</srw:numberOfRecords>
      <srw:records>
        ${tome('Ryomen Sukuna', '01', '978-1')}
        ${tome('Naissance de la matrice', '02', '978-2')}
        ${tome('Je vais te tuer', '04', '978-4')}
        ${ensemble}
        ${zero}
      </srw:records></srw:searchRetrieveResponse>`;

    const { svc } = makeService(xml);
    const mapping = await svc.enumerateEdition('Jujutsu kaisen');

    expect(mapping.tomes.map((t) => t.editionVolume)).toEqual([1, 2, 4]); // ensemble + JJK 0 exclus
    expect(mapping.tomes[0]).toMatchObject({
      editionVolume: 1,
      titleFr: 'Ryomen Sukuna',
      isbn: '978-1',
    });
    expect(mapping.tomes[2].titleFr).toBe('Je vais te tuer');
  });

  it('demande le texte imprimé seulement et cache les pages sous une clé v2', async () => {
    const { svc, queue, cache } = makeService(sruResponse(snkRecords()));
    await svc.enumerateEdition("L'attaque des titans");

    const url = new URL(queue.add.mock.calls[0][1].url);
    expect(url.searchParams.get('query')).toBe(
      'bib.title all "L\'attaque des titans" and bib.doctype any "a"',
    );
    expect(cache.set).toHaveBeenCalledWith(
      "bnf:edition-page:v2:l'attaque des titans:1",
      expect.any(String),
      7 * 24 * 3600,
    );
  });

  it("ne cache une page d'énumération vide que 24 h", async () => {
    const { svc, cache } = makeService(sruResponse([], 0));
    const mapping = await svc.enumerateEdition('Titre inconnu');
    expect(mapping.tomeCount).toBe(0);
    expect(cache.set).toHaveBeenCalledWith(
      'bnf:edition-page:v2:titre inconnu:1',
      expect.any(String),
      24 * 3600,
    );
  });

  it('collision France Loisirs : sans éditeur, retient le dominant (Pika) — T11 ne vient plus du 2-en-1', async () => {
    const { svc } = makeService(sruResponse(snkRecords()));
    const mapping = await svc.enumerateEdition("L'attaque des titans");

    expect(mapping.publisher).toBe('Pika');
    expect(mapping.tomes.map((t) => t.editionVolume)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(mapping.tomes.find((t) => t.editionVolume === 11)?.isbn).toBe(
      '978-pika-11',
    );
    expect(mapping.tomes.find((t) => t.editionVolume === 1)?.isbn).toBe(
      '978-pika-1',
    );
    // Le roman Pika (autre marque, autre auteur) n'entre pas dans la standard.
    expect(mapping.tomes.some((t) => t.isbn === '978-roman-1')).toBe(false);
  });

  describe('complete — énumération lue en entier ou non', () => {
    it('toutes les pages lues : complete = true', async () => {
      const { svc } = makeService(sruResponse(snkRecords()));
      const mapping = await svc.enumerateEdition("L'attaque des titans");
      expect(mapping.complete).toBe(true);
    });

    it('première page en échec : aucun tome ET complete = false (≠ « aucun tome »)', async () => {
      const { svc, queue } = makeService(sruResponse(snkRecords()));
      queue.add.mockRejectedValueOnce(new Error('bnf down'));
      const mapping = await svc.enumerateEdition("L'attaque des titans", null, {
        since: '20260901',
        publisher: 'Pika',
      });
      expect(mapping.tomes).toEqual([]);
      expect(mapping.complete).toBe(false);
    });

    it('page suivante en échec : tomes de la première page gardés, complete = false', async () => {
      // La première page annonce 200 notices : il faut en demander une seconde, qui échoue.
      const { svc, queue } = makeService(sruResponse(sakamotoRecords(), 200));
      queue.add
        .mockResolvedValueOnce({
          waitUntilFinished: async () => sruResponse(sakamotoRecords(), 200),
        })
        .mockRejectedValueOnce(new Error('bnf down'));
      const mapping = await svc.enumerateEdition('Sakamoto days', null, {
        publisher: 'Glénat',
      });
      expect(mapping.tomes.map((t) => t.editionVolume)).toEqual([21, 22]);
      expect(mapping.complete).toBe(false);
    });
  });

  it('éditeur explicite : énumère la 2-en-1 France Loisirs, et seulement elle', async () => {
    const { svc } = makeService(sruResponse(snkRecords()));
    const mapping = await svc.enumerateEdition("L'attaque des titans", null, {
      publisher: 'France loisirs',
    });

    expect(mapping.publisher).toBe('France loisirs');
    expect(mapping.tomes.map((t) => t.isbn)).toEqual([
      '978-fl-1-2',
      '978-fl-11-12',
    ]);
  });

  it('pré-notice (225$a = collection éditeur) : le tome le plus récent est énuméré, avec sa date de notice', async () => {
    const { svc } = makeService(sruResponse(sakamotoRecords()));
    const mapping = await svc.enumerateEdition('Sakamoto days');

    expect(mapping.tomes.map((t) => t.editionVolume)).toEqual([21, 22]);
    expect(mapping.tomes[1]).toMatchObject({
      isbn: '978-2-344-06864-9',
      noticeCreatedAt: '2026-07-28',
    });
    expect(mapping.publisher).toBe('Glénat');
    // Auteur de la pré-notice lu en 702 ; le traducteur n'est pas un auteur de la série.
    expect(mapping.authors.map((a) => a.surname)).toEqual(['Suzuki']);
  });

  it("pré-notice d'édition d'art sans 205 : jamais rangée en standard", async () => {
    const records = [
      // Pré-notice en tête : sans garde-fou, elle prendrait la place du T5 standard.
      unimarcRecord({
        isbn: '978-perfect-5',
        title: 'Hellsing perfect edition',
        volume: '5',
        uniform: 'Hellsing',
        publisher: 'Delcourt',
      }),
      ...[1, 2, 3, 4, 5].map((v) =>
        unimarcRecord({
          isbn: `978-std-${v}`,
          title: 'Hellsing',
          volume: String(v),
          publisher: 'Delcourt',
        }),
      ),
      ...[1, 2, 3, 4].map((v) =>
        unimarcRecord({
          isbn: `978-perfect-${v}`,
          title: 'Hellsing',
          volume: String(v),
          edition: 'Perfect edition',
          publisher: 'Delcourt',
        }),
      ),
    ];
    const { svc } = makeService(sruResponse(records));

    const standard = await svc.enumerateEdition('Hellsing');
    expect(standard.tomes.find((t) => t.editionVolume === 5)?.isbn).toBe(
      '978-std-5',
    );

    const perfect = await svc.enumerateEdition('Hellsing', 'Perfect edition');
    expect(perfect.tomes.map((t) => t.isbn)).toEqual([
      '978-perfect-1',
      '978-perfect-2',
      '978-perfect-3',
      '978-perfect-4',
      '978-perfect-5',
    ]);
  });

  it('rattrapage (since) : requête bib.creationdate, cache court, éditeur demandé', async () => {
    const { svc, queue, cache } = makeService(
      sruResponse([sakamotoRecords()[1]]),
    );
    const mapping = await svc.enumerateEdition('Sakamoto days', null, {
      publisher: 'Glénat',
      since: '20260701',
    });

    const url = new URL(queue.add.mock.calls[0][1].url);
    expect(url.searchParams.get('query')).toBe(
      'bib.title all "Sakamoto days" and bib.doctype any "a" and bib.creationdate >= "20260701"',
    );
    expect(cache.set).toHaveBeenCalledWith(
      'bnf:edition-since:v1:sakamoto days:20260701:1',
      expect.any(String),
      12 * 3600,
    );
    expect(mapping.tomes.map((t) => t.editionVolume)).toEqual([22]);
  });

  it("rattrapage sans éditeur : l'éditeur dominant se calcule sur l'énumération complète", async () => {
    // Seule notice récente : un 2-en-1 France Loisirs « 11-12 ». Sur ce seul sous-ensemble, il serait
    // « dominant » et retenu ; sur l'énumération complète, c'est Pika, qui a déjà un T11 — collision,
    // donc rien de neuf pour la standard.
    const recent = unimarcRecord({
      isbn: '978-fl-11-12-bis',
      title: "L'attaque des titans",
      volume: '11-12',
      publisher: 'Éditions France loisirs',
    });
    const queue = {
      add: jest.fn((_name: string, data: { url: string }) => {
        const since = new URL(data.url).searchParams
          .get('query')!
          .includes('creationdate');
        const xml = since ? sruResponse([recent]) : sruResponse(snkRecords());
        return Promise.resolve({ waitUntilFinished: async () => xml });
      }),
    };
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new BnfService(
      { get: jest.fn() } as never,
      cache as never,
      queue as never,
    );
    (svc as unknown as { queueEvents: unknown }).queueEvents = {};

    const mapping = await svc.enumerateEdition("L'attaque des titans", null, {
      since: '20260901',
    });

    expect(mapping.tomes).toEqual([]);
    expect(queue.add).toHaveBeenCalledTimes(2); // sous-ensemble récent + énumération complète
  });

  it('liste les éditions : une ligne par (éditeur, 205), homonyme d’un autre auteur écarté', async () => {
    const { svc } = makeService(sruResponse(snkRecords()));
    const { editions, complete } = await svc.listEditions(
      ["L'attaque des titans"],
      ["L'attaque des titans", 'Shingeki no Kyojin', 'Attack on Titan'],
      ['Hajime Isayama'],
    );

    expect(complete).toBe(true);
    expect(editions.map((e) => [e.publisher, e.edition, e.tomeCount])).toEqual([
      ['Pika', null, 12],
      ['France loisirs', null, 2],
      ['Pika', 'Éd. colossale', 2],
    ]);
    expect(editions[0]).toMatchObject({
      seriesTitleFr: "L'attaque des titans",
      isArtEdition: false,
      sampleIsbn: '978-pika-1',
      firstYear: '2013',
      lastYear: '2016',
    });
    expect(editions[2]).toMatchObject({
      isArtEdition: true,
      hasSourceVolumeRange: true,
    });
    // « Before the fall » (Pika roman, Ryô Suzukaze) : même ensemble 461, autre auteur → écarté.
    expect(editions.some((e) => e.publisher === 'Pika roman')).toBe(false);
  });

  it('liste les éditions depuis le romaji : rangées sous le titre FR qui rejoue edition-mapping', async () => {
    const pikaOnly = snkRecords().filter((x) => x.includes('978-pika-'));
    const { svc } = makeService(sruResponse(pikaOnly));
    const { editions } = await svc.listEditions(
      ['Shingeki no Kyojin'],
      ['Shingeki no Kyojin'],
      ['Hajime Isayama'],
    );
    expect(editions).toHaveLength(1);
    expect(editions[0]).toMatchObject({
      seriesTitleFr: "L'attaque des titans",
      publisher: 'Pika',
      tomeCount: 12,
    });
  });

  it('liste les éditions : aucune notice lue et lecture en échec → 502 (et non « aucune édition »)', async () => {
    const { svc, queue } = makeService(sruResponse(snkRecords()));
    queue.add.mockRejectedValue(new Error('bnf down'));
    await expect(
      svc.listEditions(["L'attaque des titans"], [], ['Hajime Isayama']),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('liste les éditions : page suivante en échec → éditions de la première page, complete = false', async () => {
    const { svc, queue } = makeService(sruResponse(snkRecords(), 200));
    queue.add
      .mockResolvedValueOnce({
        waitUntilFinished: async () => sruResponse(snkRecords(), 200),
      })
      .mockRejectedValueOnce(new Error('bnf down'));
    const { editions, complete } = await svc.listEditions(
      ["L'attaque des titans"],
      [],
      ['Hajime Isayama'],
    );
    expect(editions.length).toBeGreaterThan(0);
    expect(complete).toBe(false);
  });

  it('cache en panne : énumération incomplète, pas d’exception', async () => {
    const { svc, cache } = makeService(sruResponse(snkRecords()));
    cache.get.mockRejectedValue(new Error('db down'));
    const mapping = await svc.enumerateEdition("L'attaque des titans");
    expect(mapping.tomes).toEqual([]);
    expect(mapping.complete).toBe(false);
  });

  it('écriture du cache en panne : la page lue reste exploitable, complete = false', async () => {
    const { svc, cache } = makeService(sruResponse(snkRecords()));
    cache.set.mockRejectedValue(new Error('db down'));
    const mapping = await svc.enumerateEdition("L'attaque des titans");
    expect(mapping.tomes).toHaveLength(12);
    expect(mapping.complete).toBe(false);
  });

  it('éditeur dominant : il ne gagne que les collisions, un second libellé comble les trous', async () => {
    const tome = (vol: string, publisher: string, isbn: string) =>
      unimarcRecord({ isbn, title: 'Saint Seiya', volume: vol, publisher });
    const records = [
      tome('11-12', 'Éditions France loisirs', 'fl-11-12'),
      tome('17-18', 'Éditions France loisirs', 'fl-17-18'),
      ...Array.from({ length: 20 }, (_, i) =>
        tome(String(i + 1), 'Tonkam', `tonkam-${i + 1}`),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        tome(String(i + 21), 'Delcourt-Tonkam', `dt-${i + 21}`),
      ),
    ];
    const { svc } = makeService(sruResponse(records));

    const mapping = await svc.enumerateEdition('Saint Seiya');

    expect(mapping.publisher).toBe('Tonkam');
    expect(mapping.tomes).toHaveLength(30);
    expect(mapping.tomes.find((t) => t.editionVolume === 11)?.isbn).toBe(
      'tonkam-11',
    );
    expect(mapping.tomes.find((t) => t.editionVolume === 17)?.isbn).toBe(
      'tonkam-17',
    );
    expect(mapping.tomes.find((t) => t.editionVolume === 25)?.isbn).toBe(
      'dt-25',
    );

    // Éditeur explicite : filtre strict, pas de comblement.
    const strict = await svc.enumerateEdition('Saint Seiya', null, {
      publisher: 'Tonkam',
    });
    expect(strict.tomes).toHaveLength(20);
  });

  it('appartenance : 461$t fait autorité — un spin-off rattaché à un autre ensemble ne vole pas le n°', async () => {
    const records = [
      unimarcRecord({
        isbn: 'spinoff-2',
        title: 'Naruto',
        volume: '2',
        set: 'Naruto : les romans',
        setVolume: '2',
        publisher: 'Kana',
      }),
      ...[1, 2, 3].map((v) =>
        unimarcRecord({
          isbn: `naruto-${v}`,
          title: 'Naruto',
          volume: String(v),
          set: 'Naruto',
          setVolume: String(v),
          publisher: 'Kana',
        }),
      ),
    ];
    const { svc } = makeService(sruResponse(records));
    const mapping = await svc.enumerateEdition('Naruto');
    expect(mapping.tomes.map((t) => t.isbn)).toEqual([
      'naruto-1',
      'naruto-2',
      'naruto-3',
    ]);
  });

  it('appartenance sans 461 : 225$a = série reste membre même quand 500$a porte le titre japonais', async () => {
    const records = [
      unimarcRecord({
        isbn: 'pacte-3',
        title: 'Le chat porte-bonheur', // titre propre du tome
        collection: 'Le pacte des yôkai',
        collectionVolume: '3',
        uniform: 'Natsume yūjinchō',
        publisher: 'Delcourt-Tonkam',
      }),
      ...[1, 2].map((v) =>
        unimarcRecord({
          isbn: `pacte-${v}`,
          title: 'Le pacte des yôkai',
          volume: String(v),
          set: 'Le pacte des yôkai',
          setVolume: String(v),
          publisher: 'Delcourt-Tonkam',
        }),
      ),
    ];
    const { svc } = makeService(sruResponse(records));
    const mapping = await svc.enumerateEdition('Le pacte des yôkai');
    expect(mapping.tomes.map((t) => t.isbn)).toEqual([
      'pacte-1',
      'pacte-2',
      'pacte-3',
    ]);
  });

  it("série dont le titre contient un mot-clé d'art (« Perfect World ») : la standard reste entière", async () => {
    const records = [1, 2, 3].map((v) =>
      unimarcRecord({
        isbn: `pw-${v}`,
        title: 'Perfect World',
        volume: String(v),
        publisher: 'Akata',
      }),
    );
    const { svc } = makeService(sruResponse(records));
    const mapping = await svc.enumerateEdition('Perfect World');
    expect(mapping.tomes.map((t) => t.isbn)).toEqual(['pw-1', 'pw-2', 'pw-3']);
  });

  it("scan : une 214 d'imprimeur sans $c en tête ne vide pas l'éditeur de la notice", async () => {
    const xml = `<srw:searchRetrieveResponse xmlns:srw="x">
  <srw:numberOfRecords>1</srw:numberOfRecords>
  <srw:records><srw:record><srw:recordData>
    <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
      <mxc:datafield tag="200" ind1="1" ind2=" "><mxc:subfield code="a">Sakamoto days</mxc:subfield><mxc:subfield code="h">vol. 22</mxc:subfield></mxc:datafield>
      <mxc:datafield tag="214" ind1=" " ind2="3"><mxc:subfield code="a">impr. en Espagne</mxc:subfield></mxc:datafield>
      <mxc:datafield tag="214" ind1=" " ind2="0"><mxc:subfield code="a">Grenoble</mxc:subfield><mxc:subfield code="c">Glénat</mxc:subfield><mxc:subfield code="d">2026</mxc:subfield></mxc:datafield>
    </mxc:record>
  </srw:recordData></srw:record></srw:records>
</srw:searchRetrieveResponse>`;
    const { svc } = makeService(xml);
    const res = await svc.resolveByIsbn('9782344068649');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.notice.publisherFr).toBe('Glénat');
  });

  it('tombe en 500$a quand 454$t est absent', async () => {
    const xml = COLOSSALE_XML.replace(
      /<mxc:datafield tag="454"[\s\S]*?<\/mxc:datafield>/,
      '<mxc:datafield tag="500" ind1=" " ind2=" "><mxc:subfield code="a">Shingeki no kyojin</mxc:subfield></mxc:datafield>',
    );
    const { svc } = makeService(xml);
    const res = await svc.resolveByIsbn('9782811623258');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.notice.originalTitle).toBe('Shingeki no kyojin');
      expect(res.notice.originalTitleSource).toBe('500$a');
      expect(res.notice.sourceVolumeRange).toBeNull();
    }
  });
});
