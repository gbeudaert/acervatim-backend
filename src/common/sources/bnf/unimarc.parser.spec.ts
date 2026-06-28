import {
  allDatafields,
  controlfield,
  firstSubfield,
  parseUnimarc,
  subfieldOf,
} from './unimarc.parser';

// Fixture calquée sur une vraie notice BnF (Colossale SNK T.1, ISBN 9782811623258),
// avec préfixe de namespace `mxc:` et wrappers SRU `srw:`.
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
  <srw:numberOfRecords>1</srw:numberOfRecords>
  <srw:records>
    <srw:record>
      <srw:recordData>
        <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
          <mxc:controlfield tag="003">http://catalogue.bnf.fr/ark:/12148/cb44459249t</mxc:controlfield>
          <mxc:datafield tag="010" ind1=" " ind2=" ">
            <mxc:subfield code="a">978-2-8116-2325-8</mxc:subfield>
          </mxc:datafield>
          <mxc:datafield tag="200" ind1="1" ind2=" ">
            <mxc:subfield code="a">L'attaque des titans</mxc:subfield>
            <mxc:subfield code="h">1</mxc:subfield>
            <mxc:subfield code="f">Hajime Isayama</mxc:subfield>
          </mxc:datafield>
          <mxc:datafield tag="205" ind1=" " ind2=" ">
            <mxc:subfield code="a">Éd. colossale</mxc:subfield>
          </mxc:datafield>
          <mxc:datafield tag="210" ind1=" " ind2=" ">
            <mxc:subfield code="c">Pika édition</mxc:subfield>
            <mxc:subfield code="d">DL 2015</mxc:subfield>
          </mxc:datafield>
          <mxc:datafield tag="225" ind1=" " ind2=" ">
            <mxc:subfield code="a">Pika seinen</mxc:subfield>
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
      </srw:recordData>
    </srw:record>
  </srw:records>
</srw:searchRetrieveResponse>`;

const EMPTY = `<srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
  <srw:numberOfRecords>0</srw:numberOfRecords>
  <srw:records/>
</srw:searchRetrieveResponse>`;

describe('parseUnimarc', () => {
  it('compte les notices et expose numberOfRecords', () => {
    const res = parseUnimarc(FIXTURE);
    expect(res.numberOfRecords).toBe(1);
    expect(res.records).toHaveLength(1);
  });

  it('extrait les zones malgré le préfixe de namespace mxc:', () => {
    const rec = parseUnimarc(FIXTURE).records[0];
    expect(firstSubfield(rec, '010', 'a')).toBe('978-2-8116-2325-8');
    expect(firstSubfield(rec, '200', 'a')).toBe("L'attaque des titans");
    expect(firstSubfield(rec, '200', 'h')).toBe('1');
    expect(firstSubfield(rec, '200', 'f')).toBe('Hajime Isayama');
    expect(firstSubfield(rec, '205', 'a')).toBe('Éd. colossale');
    expect(firstSubfield(rec, '210', 'c')).toBe('Pika édition');
  });

  it('extrait le titre original romaji (454$t) et la plage de volumes (454$h)', () => {
    const rec = parseUnimarc(FIXTURE).records[0];
    expect(firstSubfield(rec, '454', 't')).toBe('Shingeki no kyojin');
    expect(firstSubfield(rec, '454', 'h')).toBe('vol. 1-3');
  });

  it('expose les auteurs structurés (700$a / 700$b)', () => {
    const rec = parseUnimarc(FIXTURE).records[0];
    const df = allDatafields(rec, '700')[0];
    expect(subfieldOf(df, 'a')).toBe('Isayama');
    expect(subfieldOf(df, 'b')).toBe('Hajime');
  });

  it('lit le controlfield ARK (003)', () => {
    const rec = parseUnimarc(FIXTURE).records[0];
    expect(controlfield(rec, '003')).toBe(
      'http://catalogue.bnf.fr/ark:/12148/cb44459249t',
    );
  });

  it('décode les entités XML', () => {
    const xml = FIXTURE.replace("L'attaque des titans", 'A &amp; B &lt;x&gt;');
    const rec = parseUnimarc(xml).records[0];
    expect(firstSubfield(rec, '200', 'a')).toBe('A & B <x>');
  });

  it('renvoie 0 notice sur une réponse vide', () => {
    const res = parseUnimarc(EMPTY);
    expect(res.numberOfRecords).toBe(0);
    expect(res.records).toHaveLength(0);
  });
});
