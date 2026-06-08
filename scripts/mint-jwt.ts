/**
 * CLI de dev : cree (ou reutilise) un user de test et signe un JWT interne,
 * sans passer par le vrai login Google. PrismaClient direct, sans NestJS.
 *
 * Refuse de s'executer si NODE_ENV=production (jamais de backdoor en prod).
 *
 * Usage (via le wrapper, dans le conteneur app) :
 *   ./scripts/dev.ps1 mint-jwt                         # user de test par defaut (idempotent)
 *   ./scripts/dev.ps1 mint-jwt --sub <label>           # user derive d'un label arbitraire
 *   ./scripts/dev.ps1 mint-jwt --user <userId>         # JWT pour un user existant precis
 *   ./scripts/dev.ps1 mint-jwt --expires <duration>    # ex: 30d, 1h (defaut: 7d)
 *
 * Le label est hashe HMAC-SHA-256(SUB_HASH_PEPPER, label) -> googleSubHash, exactement
 * comme un vrai sub Google. Relancer avec le meme label retombe sur le meme user (upsert).
 * Le token signe est { sub: userId } RS256, identique a celui de AuthService.
 */
import { PrismaClient } from '@prisma/client';
import { createHmac, randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';

const prisma = new PrismaClient();

const DEFAULT_LABEL = 'dev-test-user';
const DEFAULT_EXPIRES = '7d';

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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set in .env`);
  }
  return value;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('mint-jwt is disabled when NODE_ENV=production');
  }

  const flags = parseFlags(process.argv.slice(2));
  const expiresIn: jwt.SignOptions['expiresIn'] =
    (flags.expires as jwt.SignOptions['expiresIn']) ?? DEFAULT_EXPIRES;
  const privateKey = requireEnv('JWT_PRIVATE_KEY').replace(/\\n/g, '\n');

  let userId: string;

  if (flags.user) {
    const user = await prisma.user.findUnique({
      where: { id: flags.user },
      select: { id: true },
    });
    if (!user) {
      throw new Error(`user ${flags.user} not found`);
    }
    userId = user.id;
  } else {
    const label = flags.sub ?? DEFAULT_LABEL;
    const pepper = requireEnv('SUB_HASH_PEPPER');
    const subHash = createHmac('sha256', pepper).update(label).digest('hex');
    const user = await prisma.user.upsert({
      where: { googleSubHash: subHash },
      update: {},
      create: { id: randomUUID(), googleSubHash: subHash },
    });
    userId = user.id;
  }

  const accessToken = jwt.sign({ sub: userId }, privateKey, {
    algorithm: 'RS256',
    expiresIn,
  });

  await prisma.auditLog.create({
    data: {
      userId,
      action: 'auth.login',
      metadata: { provider: 'dev-mint', expiresIn },
    },
  });

  // userId + token sur stderr (lisible), token seul sur stdout (pipe-able).
  console.error(`userId=${userId} expiresIn=${expiresIn}`);
  console.log(accessToken);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
