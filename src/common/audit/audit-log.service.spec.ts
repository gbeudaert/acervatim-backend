import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from './audit-log.service';

type PrismaMock = {
  auditLog: { create: jest.Mock };
};

function makePrismaMock(): PrismaMock {
  return { auditLog: { create: jest.fn() } };
}

function makeService(prisma: PrismaMock): AuditLogService {
  return new AuditLogService(prisma as unknown as PrismaService);
}

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

describe('AuditLogService.record', () => {
  it('persiste action + userId + target + metadata', async () => {
    const prisma = makePrismaMock();
    prisma.auditLog.create.mockResolvedValue({});

    await makeService(prisma).record({
      userId: USER,
      action: 'auth.login',
      target: 'session-1',
      metadata: { provider: 'google' },
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: USER,
        action: 'auth.login',
        target: 'session-1',
        metadata: { provider: 'google' },
      },
    });
  });

  it('userId par défaut à null, target à null, metadata à Prisma.JsonNull', async () => {
    const prisma = makePrismaMock();
    prisma.auditLog.create.mockResolvedValue({});

    await makeService(prisma).record({ action: 'system.boot' });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: null,
        action: 'system.boot',
        target: null,
        metadata: Prisma.JsonNull,
      },
    });
  });

  it('avale une erreur Prisma sans throw (le métier ne doit pas casser)', async () => {
    const prisma = makePrismaMock();
    prisma.auditLog.create.mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    // Ne throw PAS
    await expect(
      makeService(prisma).record({ action: 'auth.login', userId: USER }),
    ).resolves.toBeUndefined();

    // Mais log une erreur
    expect(spy).toHaveBeenCalled();
    const msg = spy.mock.calls[0][0];
    expect(String(msg)).toContain('auth.login');
    expect(String(msg)).toContain('db down');

    spy.mockRestore();
  });

  it("expose `userId: undefined` en `null` (jamais d'undefined fuité vers Prisma)", async () => {
    const prisma = makePrismaMock();
    prisma.auditLog.create.mockResolvedValue({});

    await makeService(prisma).record({
      userId: undefined,
      action: 'user.anonymous',
    });

    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data.userId).toBeNull();
  });
});
