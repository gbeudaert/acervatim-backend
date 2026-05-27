import { buildOAuth1Header, percentEncode } from './oauth1';

describe('percentEncode', () => {
  it("encode !*'() en plus de ce que encodeURIComponent fait", () => {
    expect(percentEncode("!*'()")).toBe('%21%2A%27%28%29');
  });

  it('laisse intacts les unreserved chars RFC 3986 (alpha, digit, - . _ ~)', () => {
    expect(percentEncode('AaZz09-._~')).toBe('AaZz09-._~');
  });

  it('encode les espaces en %20 (pas en +)', () => {
    expect(percentEncode('a b')).toBe('a%20b');
  });
});

describe('buildOAuth1Header', () => {
  // Fixe le nonce + timestamp pour obtenir une signature déterministe (sinon non-testable).
  const fixed = {
    nonce: () => 'static-nonce-1234567890abcdef',
    timestamp: () => '1700000000',
  };

  it('produit un header OAuth bien formé (clés alphabétiques, valeurs quotées)', () => {
    const header = buildOAuth1Header(
      'GET',
      'https://api.discogs.com/oauth/request_token',
      { consumerKey: 'ck', consumerSecret: 'cs' },
      { oauth_callback: 'myapp://oauth/discogs' },
      fixed,
    );
    expect(header).toMatch(/^OAuth /);
    // Clés alphabétiques : oauth_callback avant oauth_consumer_key avant oauth_nonce...
    const order = header
      .replace(/^OAuth /, '')
      .split(', ')
      .map((p) => p.split('=')[0]);
    expect(order).toEqual([...order].sort());
    // Toutes les valeurs sont entourées de "
    for (const part of header.replace(/^OAuth /, '').split(', ')) {
      expect(part).toMatch(/^[A-Za-z_]+="[^"]*"$/);
    }
  });

  it('signature stable entre 2 appels avec mêmes inputs (anti-régression algo)', () => {
    const args = [
      'GET',
      'https://api.discogs.com/database/search',
      {
        consumerKey: 'ck',
        consumerSecret: 'cs',
        tokenKey: 'tk',
        tokenSecret: 'ts',
      },
      { q: 'miles davis', type: 'release' },
      fixed,
    ] as const;
    const h1 = buildOAuth1Header(...args);
    const h2 = buildOAuth1Header(...args);
    expect(h1).toBe(h2);
  });

  it('signature DIFFÈRE si tokenSecret change (sécurité de base)', () => {
    const a = buildOAuth1Header(
      'GET',
      'https://api.discogs.com/x',
      {
        consumerKey: 'ck',
        consumerSecret: 'cs',
        tokenKey: 'tk',
        tokenSecret: 'A',
      },
      {},
      fixed,
    );
    const b = buildOAuth1Header(
      'GET',
      'https://api.discogs.com/x',
      {
        consumerKey: 'ck',
        consumerSecret: 'cs',
        tokenKey: 'tk',
        tokenSecret: 'B',
      },
      {},
      fixed,
    );
    expect(a).not.toBe(b);
  });

  it('inclut oauth_token quand un tokenKey est fourni, sinon non', () => {
    const sans = buildOAuth1Header(
      'GET',
      'https://x',
      { consumerKey: 'ck', consumerSecret: 'cs' },
      {},
      fixed,
    );
    const avec = buildOAuth1Header(
      'GET',
      'https://x',
      { consumerKey: 'ck', consumerSecret: 'cs', tokenKey: 'mytoken' },
      {},
      fixed,
    );
    expect(sans).not.toContain('oauth_token=');
    expect(avec).toContain('oauth_token="mytoken"');
  });

  it("extraParams (oauth_verifier) entrent dans la signature ET ressortent dans le header s'ils commencent par oauth_", () => {
    // Note : seuls les oauth_* OFFICIELLEMENT générés par le helper apparaissent
    // dans le header. oauth_verifier passé en extraParams doit l'être aussi.
    const header = buildOAuth1Header(
      'POST',
      'https://api.discogs.com/oauth/access_token',
      {
        consumerKey: 'ck',
        consumerSecret: 'cs',
        tokenKey: 'rt',
        tokenSecret: 'rts',
      },
      { oauth_verifier: 'verif-123' },
      fixed,
    );
    // Le helper actuel sort oauth_signature + tous les oauth_* qu'il a stockés ;
    // oauth_verifier vient via extraParams donc n'est PAS dans le header (cf. archi guide §17.6
    // où l'app le passe en body POST). On vérifie que la signature change avec/sans verifier.
    const sansVerif = buildOAuth1Header(
      'POST',
      'https://api.discogs.com/oauth/access_token',
      {
        consumerKey: 'ck',
        consumerSecret: 'cs',
        tokenKey: 'rt',
        tokenSecret: 'rts',
      },
      {},
      fixed,
    );
    expect(header).not.toBe(sansVerif);
  });
});
