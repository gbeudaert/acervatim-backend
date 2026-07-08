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
    // getOrFetch exécute simplement le fetcher (pas de cache en test).
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
  return { svc, queue };
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

  it('renvoie bnf_not_found sur 0 notice', async () => {
    const { svc } = makeService(
      `<srw:searchRetrieveResponse xmlns:srw="x"><srw:numberOfRecords>0</srw:numberOfRecords></srw:searchRetrieveResponse>`,
    );
    const res = await svc.resolveByIsbn('0000000000000');
    expect(res).toEqual({ ok: false, reason: 'bnf_not_found' });
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
