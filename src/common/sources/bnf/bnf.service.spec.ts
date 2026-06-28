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

function makeService(xml: string | (() => Promise<unknown>)) {
  const http = {
    request: jest
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, data: xml }),
  };
  const cache = {
    // getOrFetch exécute simplement le fetcher (pas de cache en test).
    getOrFetch: jest.fn(
      (_k: string, _ttl: number, fetcher: () => Promise<unknown>) => fetcher(),
    ),
  };
  const bucket = { consume: jest.fn().mockResolvedValue(true) };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const svc = new BnfService(
    config as never,
    http as never,
    cache as never,
    bucket as never,
  );
  svc.onModuleInit();
  return { svc, http, bucket };
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

  it('renvoie bnf_rate_limited quand le bucket refuse', async () => {
    const { svc, bucket } = makeService(COLOSSALE_XML);
    bucket.consume.mockResolvedValueOnce(false);
    const res = await svc.resolveByIsbn('9782811623258');
    expect(res).toEqual({ ok: false, reason: 'bnf_rate_limited' });
  });

  it('détecte une série en cours sur date ouverte (210$d "2015-")', async () => {
    const xml = COLOSSALE_XML.replace('DL 2015', '2015-');
    const { svc } = makeService(xml);
    const res = await svc.resolveByIsbn('9782811623258');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.notice.ongoing).toBe(true);
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
