import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  GooglePlayService,
  PlaySubscriptionSnapshot,
} from './google-play.service';
import { SubscriptionsService } from './subscriptions.service';

type PrismaMock = {
  subscription: {
    upsert: jest.Mock;
    update: jest.Mock;
    findUnique: jest.Mock;
  };
};

function makePrismaMock(): PrismaMock {
  return {
    subscription: {
      upsert: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
  };
}

function makeAuditMock(): { record: jest.Mock } {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

function makeService(
  prisma: PrismaMock,
  play: { getSubscription: jest.Mock },
  audit: { record: jest.Mock },
): SubscriptionsService {
  return new SubscriptionsService(
    prisma as unknown as PrismaService,
    play as unknown as GooglePlayService,
    audit as unknown as AuditLogService,
  );
}

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const TOKEN = 'token-123';
const PRODUCT = 'premium_monthly';
const FUTURE_MS = Date.now() + 30 * 86_400_000;

function makeSnapshot(
  overrides: Partial<PlaySubscriptionSnapshot> = {},
): PlaySubscriptionSnapshot {
  return {
    state: 'SUBSCRIPTION_STATE_ACTIVE',
    expiresAt: FUTURE_MS,
    autoRenew: true,
    productId: PRODUCT,
    ...overrides,
  };
}

function encodeRtdn(payload: Record<string, unknown>) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      messageId: 'msg-1',
    },
  };
}

describe('SubscriptionsService.handleVerify', () => {
  it('upsert la row avec status="active" + audit log', async () => {
    const prisma = makePrismaMock();
    const play = {
      getSubscription: jest.fn().mockResolvedValue(makeSnapshot()),
    };
    const audit = makeAuditMock();

    const res = await makeService(prisma, play, audit).handleVerify(
      USER,
      TOKEN,
      PRODUCT,
    );

    expect(res).toMatchObject({
      status: 'active',
      expiresAt: FUTURE_MS,
      autoRenew: true,
      productId: PRODUCT,
    });
    expect(prisma.subscription.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.subscription.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ userId: USER });
    expect(call.create.status).toBe('active');
    expect(call.create.expiresAt).toBe(BigInt(FUTURE_MS));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        action: 'subscription.verify',
        target: USER,
      }),
    );
  });

  it('mappe SUBSCRIPTION_STATE_IN_GRACE_PERIOD → "grace_period"', async () => {
    const prisma = makePrismaMock();
    const play = {
      getSubscription: jest
        .fn()
        .mockResolvedValue(
          makeSnapshot({ state: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' }),
        ),
    };
    const res = await makeService(prisma, play, makeAuditMock()).handleVerify(
      USER,
      TOKEN,
      PRODUCT,
    );
    expect(res.status).toBe('grace_period');
  });

  it('throw 400 si Google ne retourne rien', async () => {
    const prisma = makePrismaMock();
    const play = { getSubscription: jest.fn().mockResolvedValue(null) };
    await expect(
      makeService(prisma, play, makeAuditMock()).handleVerify(
        USER,
        TOKEN,
        PRODUCT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.subscription.upsert).not.toHaveBeenCalled();
  });

  it('throw 400 si productId ne matche pas le token Google (anti-spoofing)', async () => {
    const prisma = makePrismaMock();
    const play = {
      getSubscription: jest
        .fn()
        .mockResolvedValue(makeSnapshot({ productId: 'other_product' })),
    };
    await expect(
      makeService(prisma, play, makeAuditMock()).handleVerify(
        USER,
        TOKEN,
        PRODUCT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SubscriptionsService.handleRtdn', () => {
  it('outcome=updated quand purchaseToken connu : re-query Google + update', async () => {
    const prisma = makePrismaMock();
    prisma.subscription.findUnique.mockResolvedValue({ userId: USER });
    const play = {
      getSubscription: jest
        .fn()
        .mockResolvedValue(
          makeSnapshot({ state: 'SUBSCRIPTION_STATE_CANCELED' }),
        ),
    };
    const audit = makeAuditMock();

    const res = await makeService(prisma, play, audit).handleRtdn(
      encodeRtdn({
        subscriptionNotification: {
          notificationType: 3,
          purchaseToken: TOKEN,
        },
      }),
    );

    expect(res).toEqual({ outcome: 'updated' });
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER },
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        action: 'subscription.rtdn.received',
      }),
    );
  });

  it('outcome=pending_verify quand purchaseToken inconnu (RTDN avant /verify)', async () => {
    const prisma = makePrismaMock();
    prisma.subscription.findUnique.mockResolvedValue(null);
    const play = { getSubscription: jest.fn() };

    const res = await makeService(prisma, play, makeAuditMock()).handleRtdn(
      encodeRtdn({
        subscriptionNotification: { notificationType: 4, purchaseToken: TOKEN },
      }),
    );

    expect(res).toEqual({ outcome: 'pending_verify' });
    expect(play.getSubscription).not.toHaveBeenCalled();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  it('outcome=ignored quand pas de subscriptionNotification (testNotification)', async () => {
    const prisma = makePrismaMock();
    const play = { getSubscription: jest.fn() };

    const res = await makeService(prisma, play, makeAuditMock()).handleRtdn(
      encodeRtdn({ testNotification: { version: '1.0' } }),
    );

    expect(res).toEqual({ outcome: 'ignored' });
    expect(prisma.subscription.findUnique).not.toHaveBeenCalled();
    expect(play.getSubscription).not.toHaveBeenCalled();
  });

  it('throw 400 si body Pub/Sub mal formé (pas de message.data)', async () => {
    await expect(
      makeService(
        makePrismaMock(),
        { getSubscription: jest.fn() },
        makeAuditMock(),
      ).handleRtdn({}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("throw 400 si data n'est pas du JSON base64 valide", async () => {
    await expect(
      makeService(
        makePrismaMock(),
        { getSubscription: jest.fn() },
        makeAuditMock(),
      ).handleRtdn({ message: { data: 'not-base64-json' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throw 404 si Google ne reconnaît plus le token (race rare)', async () => {
    const prisma = makePrismaMock();
    prisma.subscription.findUnique.mockResolvedValue({ userId: USER });
    const play = { getSubscription: jest.fn().mockResolvedValue(null) };

    await expect(
      makeService(prisma, play, makeAuditMock()).handleRtdn(
        encodeRtdn({
          subscriptionNotification: {
            notificationType: 13,
            purchaseToken: TOKEN,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
