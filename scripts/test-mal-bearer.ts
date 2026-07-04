/**
 * Question Q-b de l'etude comptes (docs/travail/etude-conformite-comptes.md) :
 * les endpoints PUBLICS MyAnimeList acceptent-ils un jeton OAuth utilisateur
 * (`Authorization: Bearer`) pour les memes donnees que `X-MAL-CLIENT-ID` ?
 * Si oui, le pivot ISBN peut tourner en BYOT avec le jeton de l'utilisateur.
 *
 * PrismaClient direct, sans NestJS, pour rester rapide a executer.
 *
 * Usage (via le wrapper, dans le conteneur app) :
 *   ./scripts/dev.ps1 test-mal-bearer --user <userId> [--query <titre>]
 *   ./scripts/dev.ps1 test-mal-bearer --token <accessToken> [--query <titre>]
 *
 * `--user` lit le jeton MAL de l'utilisateur dans oauth_credentials et le
 * dechiffre (requiert ENCRYPTION_KEY). `--token` court-circuite la base.
 * MAL_CLIENT_ID est requis pour la branche de reference. Le jeton n'est
 * jamais affiche.
 */
import { PrismaClient } from '@prisma/client';
import { createDecipheriv } from 'crypto';

const MAL_API_BASE = 'https://api.myanimelist.net/v2';
const FIELDS =
  'id,title,alternative_titles,media_type,status,num_volumes,authors{first_name,last_name}';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

const prisma = new PrismaClient();

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`flag --${key} requires a value`);
    }
    flags[key] = value;
    i += 1;
  }
  return flags;
}

/** Meme format que AesService.decrypt : base64(iv || authTag || ciphertext), AES-256-GCM. */
function decrypt(payload: string): string {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('ENCRYPTION_KEY must be set to decrypt the stored token');
  }
  const key = Buffer.from(raw, 'base64');
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('AES payload too short');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ct = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    'utf8',
  );
}

async function loadUserToken(userId: string): Promise<string> {
  const row = await prisma.oauthCredential.findUnique({
    where: { userId_provider: { userId, provider: 'mal' } },
  });
  if (!row) {
    throw new Error(
      `no MAL credential for user=${userId} — run the /v1/oauth/mal/start flow first`,
    );
  }
  const expiresAt = Number(row.expiresAt);
  if (expiresAt !== 0 && expiresAt <= Date.now()) {
    console.warn(
      `warning: stored MAL token expired at ${new Date(expiresAt).toISOString()} — expect 401`,
    );
  }
  return decrypt(row.accessTokenEncrypted);
}

/** JSON.stringify a cles triees, pour une comparaison insensible a l'ordre. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );
}

interface FetchResult {
  status: number;
  body: unknown;
}

async function call(
  url: string,
  headers: Record<string, string>,
): Promise<FetchResult> {
  const res = await fetch(url, { headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => null);
  }
  return { status: res.status, body };
}

function compare(label: string, a: FetchResult, b: FetchResult): boolean {
  console.log(
    `\n[${label}] client-id: HTTP ${a.status} | bearer: HTTP ${b.status}`,
  );
  if (a.status !== b.status) {
    console.log(
      `  MISMATCH status — bearer body: ${stableStringify(b.body).slice(0, 300)}`,
    );
    return false;
  }
  const sa = stableStringify(a.body);
  const sb = stableStringify(b.body);
  if (sa === sb) {
    console.log('  bodies identical');
    return true;
  }
  console.log(
    `  bodies differ (client-id ${sa.length} chars vs bearer ${sb.length} chars) — a inspecter manuellement`,
  );
  return false;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const clientId = process.env.MAL_CLIENT_ID;
  if (!clientId) {
    throw new Error('MAL_CLIENT_ID must be set (reference branch)');
  }

  let bearer: string;
  if (flags.token) {
    bearer = flags.token;
  } else if (flags.user) {
    bearer = await loadUserToken(flags.user);
  } else {
    console.log(
      `usage:
  test-mal-bearer --user <userId> [--query <titre>]
  test-mal-bearer --token <accessToken> [--query <titre>]`,
    );
    process.exitCode = 1;
    return;
  }

  const query = flags.query ?? 'one piece';
  const clientIdHeaders = { 'X-MAL-CLIENT-ID': clientId };
  const bearerHeaders = { Authorization: `Bearer ${bearer}` };

  // 1. Recherche publique — meme forme d'appel que le pivot ISBN (malPublicGet).
  const searchUrl = `${MAL_API_BASE}/manga?q=${encodeURIComponent(query)}&limit=3&fields=${encodeURIComponent(FIELDS)}`;
  const searchA = await call(searchUrl, clientIdHeaders);
  const searchB = await call(searchUrl, bearerHeaders);
  const searchOk = compare(`search q="${query}"`, searchA, searchB);

  // 2. Details d'une fiche — l'id est pris dans la reponse de reference.
  let detailsOk = true;
  const firstId = (searchA.body as { data?: { node?: { id?: number } }[] })
    ?.data?.[0]?.node?.id;
  if (firstId) {
    const detailsUrl = `${MAL_API_BASE}/manga/${firstId}?fields=${encodeURIComponent(FIELDS)}`;
    const detailsA = await call(detailsUrl, clientIdHeaders);
    const detailsB = await call(detailsUrl, bearerHeaders);
    detailsOk = compare(`details id=${firstId}`, detailsA, detailsB);
  } else {
    console.warn(
      '\nno search result from the client-id branch — details step skipped',
    );
  }

  console.log(
    `\nverdict Q-b: ${
      searchOk && detailsOk
        ? 'OK — le Bearer utilisateur sert les memes donnees publiques que X-MAL-CLIENT-ID'
        : 'KO ou a inspecter — voir les ecarts ci-dessus'
    }`,
  );
  if (!(searchOk && detailsOk)) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
