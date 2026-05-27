import { INestApplication, RequestMethod } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes } from 'crypto';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { AppModule } from '../app.module';
import { GoogleIdentityProvider } from '../auth/providers/google.provider';
import { ProblemDetailsExceptionFilter } from '../common/filters/problem-details.filter';
import { CorrelationIdInterceptor } from '../common/interceptors/correlation-id.interceptor';
import { PrismaService } from '../prisma/prisma.service';

class FakeGoogleProvider {
  readonly name = 'google';
  subject = '';
  verify(_credential: unknown) {
    return Promise.resolve({ subject: this.subject });
  }
}

async function login(
  app: INestApplication,
  fake: FakeGoogleProvider,
  sub: string,
) {
  fake.subject = sub;
  const res = await request(app.getHttpServer())
    .post('/v1/auth/google')
    .send({ idToken: 'fake-token' })
    .expect(200);
  return {
    token: res.body.accessToken as string,
    userId: res.body.userId as string,
  };
}

async function cleanupUser(prisma: PrismaService, userId: string) {
  await prisma.premiumGrant
    .deleteMany({ where: { userId } })
    .catch(() => undefined);
  await prisma.invitationRedemption
    .deleteMany({ where: { userId } })
    .catch(() => undefined);
  await prisma.auditLog.deleteMany({ where: { userId } });
  await prisma.user
    .deleteMany({ where: { id: userId } })
    .catch(() => undefined);
}

describe('Invitations (e2e) — admin create + user redeem + idempotence', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeGoogle: FakeGoogleProvider;
  let adminToken: string;
  const codeHashesToCleanup: string[] = [];

  beforeAll(async () => {
    adminToken = process.env.ADMIN_API_TOKEN!;
    expect(adminToken).toBeDefined();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GoogleIdentityProvider)
      .useValue(new FakeGoogleProvider())
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1', {
      exclude: [
        { path: 'health', method: RequestMethod.ALL },
        { path: 'health/(.*)', method: RequestMethod.ALL },
      ],
    });
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalInterceptors(new CorrelationIdInterceptor());
    app.useGlobalFilters(new ProblemDetailsExceptionFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    fakeGoogle = moduleRef.get(
      GoogleIdentityProvider,
    ) as unknown as FakeGoogleProvider;
  });

  afterAll(async () => {
    if (codeHashesToCleanup.length > 0) {
      await prisma.invitationRedemption
        .deleteMany({
          where: { invitationCodeHash: { in: codeHashesToCleanup } },
        })
        .catch(() => undefined);
      await prisma.invitation
        .deleteMany({ where: { codeHash: { in: codeHashesToCleanup } } })
        .catch(() => undefined);
    }
    await app.close();
  });

  it('admin create → user redeem → grant premium en DB → second redeem idempotent', async () => {
    // 1. Admin crée une invitation premium
    const created = await request(app.getHttpServer())
      .post('/v1/admin/invitations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        reason: 'comp',
        grantsPremium: true,
        maxUses: 1,
      })
      .expect(201);

    expect(created.body.code).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(created.body.codeHash).toMatch(/^[0-9a-f]{64}$/);
    const { code, codeHash } = created.body;
    codeHashesToCleanup.push(codeHash);

    // 2. Un user se log et claim le code
    const sub = `e2e-inv-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      const first = await request(app.getHttpServer())
        .post('/v1/invitations/redeem')
        .set('Authorization', `Bearer ${token}`)
        .send({ code })
        .expect(200);

      expect(first.body).toEqual({
        alreadyRedeemed: false,
        premiumGranted: true,
        reason: 'comp',
      });

      // 3. Vérifs DB : la redemption existe + un premium grant a été créé
      const redemption = await prisma.invitationRedemption.findUnique({
        where: {
          invitationCodeHash_userId: {
            invitationCodeHash: codeHash,
            userId,
          },
        },
      });
      expect(redemption).not.toBeNull();

      const grant = await prisma.premiumGrant.findUnique({
        where: { userId },
      });
      expect(grant).not.toBeNull();
      expect(grant?.reason).toBe('comp');

      // 4. usedCount a été incrémenté à 1
      const inv = await prisma.invitation.findUnique({ where: { codeHash } });
      expect(inv?.usedCount).toBe(1);

      // 5. Second redeem du même user → idempotent (alreadyRedeemed=true)
      const second = await request(app.getHttpServer())
        .post('/v1/invitations/redeem')
        .set('Authorization', `Bearer ${token}`)
        .send({ code })
        .expect(200);

      expect(second.body.alreadyRedeemed).toBe(true);
      expect(second.body.premiumGranted).toBe(true);

      // usedCount ne bouge pas (idempotence ne consomme pas la place)
      const invAfter = await prisma.invitation.findUnique({
        where: { codeHash },
      });
      expect(invAfter?.usedCount).toBe(1);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('code inexistant → 404 Problem Details', async () => {
    const sub = `e2e-inv-404-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    try {
      const res = await request(app.getHttpServer())
        .post('/v1/invitations/redeem')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: 'definitely-not-a-real-code' });
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.type).toContain('/probs/not-found');
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('invitation expirée → 410 /probs/invitation-expired', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/admin/invitations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        reason: 'comp',
        grantsPremium: false,
        maxUses: 1,
        expiresAt: Date.now() - 60_000, // expirée il y a 1 min
      })
      .expect(201);
    const { code, codeHash } = created.body;
    codeHashesToCleanup.push(codeHash);

    const sub = `e2e-inv-410-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    try {
      const res = await request(app.getHttpServer())
        .post('/v1/invitations/redeem')
        .set('Authorization', `Bearer ${token}`)
        .send({ code });
      expect(res.status).toBe(410);
      expect(res.body.type).toContain('/probs/invitation-expired');
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('invitation épuisée (steady-state) → 409 /probs/invitation-exhausted', async () => {
    // Crée avec maxUses=1, force usedCount=1 directement en DB
    const created = await request(app.getHttpServer())
      .post('/v1/admin/invitations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'comp', grantsPremium: false, maxUses: 1 })
      .expect(201);
    const { code, codeHash } = created.body;
    codeHashesToCleanup.push(codeHash);

    await prisma.invitation.update({
      where: { codeHash },
      data: { usedCount: 1 },
    });

    const sub = `e2e-inv-409-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    try {
      const res = await request(app.getHttpServer())
        .post('/v1/invitations/redeem')
        .set('Authorization', `Bearer ${token}`)
        .send({ code });
      expect(res.status).toBe(409);
      expect(res.body.type).toContain('/probs/invitation-exhausted');
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('POST /v1/admin/invitations sans bearer admin → 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/admin/invitations')
      .send({ reason: 'comp' });
    expect(res.status).toBe(401);
  });

  it('POST /v1/admin/invitations avec mauvais bearer admin → 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/admin/invitations')
      .set('Authorization', 'Bearer wrong-token-1234567890abcdef')
      .send({ reason: 'comp' });
    expect(res.status).toBe(401);
  });

  it('POST /v1/invitations/redeem sans JWT → 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/invitations/redeem')
      .send({ code: 'whatever-code-here' });
    expect(res.status).toBe(401);
  });
});
