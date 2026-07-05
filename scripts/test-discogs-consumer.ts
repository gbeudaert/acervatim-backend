/**
 * Vérification T8 : le repli premium Discogs signe en OAuth 1.0a **consumer-only**
 * (sans access token utilisateur). Ce script rejoue exactement cette signature sur
 * `database/search` et vérifie que Discogs traite la requête comme **authentifiée** :
 *   - HTTP 200 ;
 *   - `X-Discogs-Ratelimit: 60` (authentifié) et non 25 (anonyme) ;
 *   - les résultats portent des images (`cover_image` / `thumb`) — réservées aux
 *     requêtes authentifiées.
 *
 * Usage : ./scripts/dev.ps1 test-discogs-consumer
 */
import * as fs from 'fs';
import { buildOAuth1Header } from '../src/oauth/providers/oauth1';

/**
 * Lecture ciblée d'une variable dans `.env`. On n'utilise pas dotenv : son parseur
 * global bute sur la clé PEM multi-lignes (`JWT_PRIVATE_KEY`) et n'atteint pas les
 * lignes suivantes. Ici on cherche juste les deux clés Discogs.
 */
function readEnvVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const content = fs.readFileSync('.env', 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
      if (m) {
        let v = m[1].trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        return v || undefined;
      }
    }
  } catch {
    /* .env absent : on retombe sur process.env */
  }
  return undefined;
}

async function main(): Promise<void> {
  const consumerKey = readEnvVar('DISCOGS_CONSUMER_KEY');
  const consumerSecret = readEnvVar('DISCOGS_CONSUMER_SECRET');
  const userAgent =
    readEnvVar('HTTP_USER_AGENT') ?? 'AcervatimBackend/1.0 (+test)';
  if (!consumerKey || !consumerSecret) {
    console.error(
      'DISCOGS_CONSUMER_KEY / DISCOGS_CONSUMER_SECRET manquants dans l’env',
    );
    process.exit(1);
  }

  const base = 'https://api.discogs.com/database/search';
  const params = new URLSearchParams({
    q: 'nirvana nevermind',
    type: 'release',
    per_page: '3',
  });
  const url = `${base}?${params.toString()}`;

  async function probe(label: string, authHeader: string): Promise<void> {
    const res = await fetch(url, {
      headers: { Authorization: authHeader, 'User-Agent': userAgent },
    });
    const rateLimit = res.headers.get('x-discogs-ratelimit');
    const body = (await res.json()) as {
      results?: { title?: string; cover_image?: string; thumb?: string }[];
    };
    const results = body.results ?? [];
    const withImage = results.filter((r) => r.cover_image || r.thumb).length;
    console.log(`\n[${label}]`);
    console.log(
      `  HTTP ${res.status} | ratelimit ${rateLimit} (60=auth, 25=anonyme) | images ${withImage}/${results.length}`,
    );
    console.log('  1er cover_image :', results[0]?.cover_image || '(aucune)');
  }

  // 1) Signature consumer-only (ce que fait le repli SANS personal token).
  await probe(
    'consumer-only (repli par défaut)',
    buildOAuth1Header(
      'GET',
      base,
      { consumerKey, consumerSecret },
      Object.fromEntries(params),
    ),
  );

  // 2) Personal access token, si présent (ce que fait le repli AVEC le token).
  const personalToken = readEnvVar('DISCOGS_ACERVATIM_TOKEN');
  if (personalToken) {
    await probe(
      'personal token (DISCOGS_ACERVATIM_TOKEN)',
      `Discogs token=${personalToken}`,
    );
  } else {
    console.log(
      '\n[personal token] DISCOGS_ACERVATIM_TOKEN absent — ajoute-le à .env pour comparer (images attendues).',
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
