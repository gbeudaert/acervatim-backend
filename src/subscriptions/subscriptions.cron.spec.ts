import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsCronService } from './subscriptions.cron';
import { SubscriptionsService } from './subscriptions.service';

type PrismaMock = {
  subscription: { findMany: jest.Mock };
};

function makePrismaMock(): PrismaMock {
  return { subscription: { findMany: jest.fn() } };
}

function makeService(
  prisma: PrismaMock,
  subs: { refreshFromGoogle: jest.Mock },
): SubscriptionsCronService {
  return new SubscriptionsCronService(
    prisma as unknown as PrismaService,
    subs as unknown as SubscriptionsService,
  );
}

const USER_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

describe('SubscriptionsCronService.reverifyExpiringSoon', () => {
  it('re-vérifie chaque sub dû et retourne checked/updated', async () => {
    const prisma = makePrismaMock();
    prisma.subscription.findMany.mockResolvedValue([
      { userId: USER_A, purchaseToken: 'tok-a' },
      { userId: USER_B, purchaseToken: 'tok-b' },
    ]);
    const subs = {
      refreshFromGoogle: jest.fn().mockResolvedValue('active'),
    };

    const res = await makeService(prisma, subs).reverifyExpiringSoon();

    expect(res).toEqual({ checked: 2, updated: 2 });
    expect(subs.refreshFromGoogle).toHaveBeenCalledWith(USER_A, 'tok-a');
    expect(subs.refreshFromGoogle).toHaveBeenCalledWith(USER_B, 'tok-b');
  });

  it('query : status in {active,grace_period} ET expiresAt < cutoff (24h)', async () => {
    const prisma = makePrismaMock();
    prisma.subscription.findMany.mockResolvedValue([]);
    const before = Date.now() + 24 * 60 * 60 * 1000;

    await makeService(prisma, {
      refreshFromGoogle: jest.fn(),
    }).reverifyExpiringSoon();

    const after = Date.now() + 24 * 60 * 60 * 1000;
    const arg = prisma.subscription.findMany.mock.calls[0][0];
    expect(arg.where.status).toEqual({ in: ['active', 'grace_period'] });
    const cutoff = arg.where.expiresAt.lt as bigint;
    expect(typeof cutoff).toBe('bigint');
    expect(Number(cutoff)).toBeGreaterThanOrEqual(before);
    expect(Number(cutoff)).toBeLessThanOrEqual(after);
  });

  it("un échec sur un sub n'arrête pas le cycle (log + continue)", async () => {
    const prisma = makePrismaMock();
    prisma.subscription.findMany.mockResolvedValue([
      { userId: USER_A, purchaseToken: 'tok-a' },
      { userId: USER_B, purchaseToken: 'tok-b' },
    ]);
    const subs = {
      refreshFromGoogle: jest
        .fn()
        .mockRejectedValueOnce(new Error('google 503'))
        .mockResolvedValueOnce('active'),
    };

    const res = await makeService(prisma, subs).reverifyExpiringSoon();

    expect(res).toEqual({ checked: 2, updated: 1 });
    expect(subs.refreshFromGoogle).toHaveBeenCalledTimes(2);
  });

  it('un sub dont Google ne reconnaît plus le token (null) ne compte pas comme updated', async () => {
    const prisma = makePrismaMock();
    prisma.subscription.findMany.mockResolvedValue([
      { userId: USER_A, purchaseToken: 'tok-a' },
    ]);
    const subs = { refreshFromGoogle: jest.fn().mockResolvedValue(null) };

    const res = await makeService(prisma, subs).reverifyExpiringSoon();

    expect(res).toEqual({ checked: 1, updated: 0 });
  });

  it("aucun sub dû → checked 0, updated 0, pas d'appel Google", async () => {
    const prisma = makePrismaMock();
    prisma.subscription.findMany.mockResolvedValue([]);
    const subs = { refreshFromGoogle: jest.fn() };

    const res = await makeService(prisma, subs).reverifyExpiringSoon();

    expect(res).toEqual({ checked: 0, updated: 0 });
    expect(subs.refreshFromGoogle).not.toHaveBeenCalled();
  });
});
