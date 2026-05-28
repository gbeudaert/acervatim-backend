/**
 * CLI de gestion des premium grants (overrides admin).
 * PrismaClient direct, sans NestJS, pour rester rapide a executer.
 *
 * Usage (via le wrapper, dans le conteneur app) :
 *   ./scripts/dev.ps1 grant-premium add <userId> --reason <reason> [--expires <epochMs>] [--notes <text>]
 *   ./scripts/dev.ps1 grant-premium revoke <userId>
 *   ./scripts/dev.ps1 grant-premium list
 *
 * `add` upsert un premium_grants + ecrit un audit_logs `premium.grant.add`
 * (target = userId cible). `revoke` supprime + audit `premium.grant.revoke`.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const KNOWN_REASONS = ['self', 'beta_tester', 'comp', 'support', 'admin'];

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

async function add(
  userId: string,
  flags: Record<string, string>,
): Promise<void> {
  if (!userId) {
    throw new Error(
      'usage: add <userId> --reason <reason> [--expires <epochMs>] [--notes <text>]',
    );
  }
  const reason = flags.reason ?? 'admin';
  if (reason.length > 32) {
    throw new Error('--reason must be <= 32 chars');
  }
  if (!KNOWN_REASONS.includes(reason)) {
    console.warn(
      `warning: reason "${reason}" not in known set [${KNOWN_REASONS.join(', ')}]`,
    );
  }

  let expiresAt: bigint | null = null;
  if (flags.expires !== undefined) {
    if (!/^\d+$/.test(flags.expires)) {
      throw new Error('--expires must be an epoch-ms integer');
    }
    expiresAt = BigInt(flags.expires);
  }
  const notes = flags.notes ?? null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) {
    throw new Error(`user ${userId} not found`);
  }

  await prisma.premiumGrant.upsert({
    where: { userId },
    create: { userId, reason, grantedBy: 'cli', expiresAt, notes },
    update: {
      reason,
      grantedBy: 'cli',
      expiresAt,
      notes,
      grantedAt: new Date(),
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: null, // action CLI non attribuable a un user authentifie
      action: 'premium.grant.add',
      target: userId,
      metadata: {
        reason,
        expiresAt: expiresAt !== null ? Number(expiresAt) : null,
        grantedBy: 'cli',
      },
    },
  });

  const expiryLabel =
    expiresAt !== null
      ? new Date(Number(expiresAt)).toISOString()
      : 'permanent';
  console.log(
    `OK premium.grant.add user=${userId} reason=${reason} expires=${expiryLabel}`,
  );
}

async function revoke(userId: string): Promise<void> {
  if (!userId) {
    throw new Error('usage: revoke <userId>');
  }
  const existing = await prisma.premiumGrant.findUnique({ where: { userId } });
  if (!existing) {
    console.log(`no premium grant for user=${userId} (nothing to revoke)`);
    return;
  }

  await prisma.premiumGrant.delete({ where: { userId } });
  await prisma.auditLog.create({
    data: {
      userId: null,
      action: 'premium.grant.revoke',
      target: userId,
      metadata: { reason: existing.reason },
    },
  });
  console.log(`OK premium.grant.revoke user=${userId}`);
}

async function list(): Promise<void> {
  const grants = await prisma.premiumGrant.findMany({
    orderBy: { grantedAt: 'desc' },
  });
  if (grants.length === 0) {
    console.log('no premium grants');
    return;
  }
  const now = Date.now();
  console.table(
    grants.map((g) => ({
      userId: g.userId,
      reason: g.reason,
      grantedBy: g.grantedBy ?? '',
      grantedAt: g.grantedAt.toISOString(),
      expiresAt:
        g.expiresAt !== null
          ? new Date(Number(g.expiresAt)).toISOString()
          : 'permanent',
      active: g.expiresAt === null || Number(g.expiresAt) > now,
    })),
  );
}

async function main(): Promise<void> {
  const [command, userId, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'add':
      await add(userId, parseFlags(rest));
      break;
    case 'revoke':
      await revoke(userId);
      break;
    case 'list':
      await list();
      break;
    default:
      console.log(
        `usage:
  add <userId> --reason <reason> [--expires <epochMs>] [--notes <text>]
  revoke <userId>
  list`,
      );
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
