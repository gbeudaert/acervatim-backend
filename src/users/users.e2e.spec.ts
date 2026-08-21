import { INestApplication, RequestMethod } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import { randomBytes } from 'crypto';
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

describe('Users (e2e) — /v1/me, /v1/me/export, /v1/me delete', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeGoogle: FakeGoogleProvider;

  beforeAll(async () => {
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
    await app.close();
  });

  it("flow complet : login → me → export → delete → me 401, plus traces d'audit", async () => {
    const sub = `e2e-users-sub-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      // GET /v1/me
      const me = await request(app.getHttpServer())
        .get('/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(me.body.userId).toBe(userId);
      expect(typeof me.body.createdAt).toBe('string');
      expect(me.body.premium).toEqual({
        isPremium: false,
        source: 'none',
        expiresAt: null,
      });

      // GET /v1/me/export
      const exp = await request(app.getHttpServer())
        .get('/v1/me/export')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(exp.headers['content-disposition']).toContain('attachment');
      expect(exp.headers['content-disposition']).toContain(userId);
      const payload = JSON.parse(exp.text);
      expect(payload.schemaVersion).toBe(1);
      expect(payload.data.user.id).toBe(userId);
      expect(Array.isArray(payload.data.collections)).toBe(true);
      // Les nœuds (séries) font partie du miroir : sans eux l'export RGPD est amputé (S1bis).
      expect(Array.isArray(payload.data.collectionNodes)).toBe(true);
      expect(Array.isArray(payload.data.items)).toBe(true);
      expect(Array.isArray(payload.data.oauthCredentials)).toBe(true);
      expect(Array.isArray(payload.data.invitationRedemptions)).toBe(true);
      expect(Array.isArray(payload.data.auditLogs)).toBe(true);

      // DELETE /v1/me
      await request(app.getHttpServer())
        .delete('/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // GET /v1/me avec un token dont l'user n'existe plus → 404 (user not found)
      const after = await request(app.getHttpServer())
        .get('/v1/me')
        .set('Authorization', `Bearer ${token}`);
      expect(after.status).toBe(404);
      expect(after.headers['content-type']).toContain(
        'application/problem+json',
      );

      // Audit logs : auth.login + user.export + user.delete présents
      const actions = await prisma.auditLog.findMany({
        where: { userId },
        select: { action: true },
      });
      const set = new Set(actions.map((a) => a.action));
      expect(set.has('auth.login')).toBe(true);
      expect(set.has('user.export')).toBe(true);
      expect(set.has('user.delete')).toBe(true);

      // L'user a bien été supprimé en DB (cascade Prisma)
      const userInDb = await prisma.user.findUnique({ where: { id: userId } });
      expect(userInDb).toBeNull();
    } finally {
      // Nettoyage : audit_logs n'a pas de FK, on les supprime explicitement.
      await prisma.auditLog.deleteMany({ where: { userId } });
      await prisma.user
        .deleteMany({ where: { id: userId } })
        .catch(() => undefined);
    }
  });

  // S1bis — l'export RGPD est le test le plus large du « miroir complet » : tout ce que le
  // serveur détient doit en sortir, y compris le niveau série.
  it('GET /v1/me/export : collections, nœuds ET items, avec leurs trois blocs JSON', async () => {
    const sub = `e2e-export-miroir-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    try {
      // Depuis S2 la sync est premium-only : sans grant, POST /collections repond 402.
      await prisma.premiumGrant.create({
        data: { userId, reason: 'beta_tester', expiresAt: null },
      });
      const coll = await request(app.getHttpServer())
        .post('/v1/collections')
        .set('Authorization', `Bearer ${token}`)
        .send({ typeCode: 'manga', name: 'Mes séries' })
        .expect(201);
      const collectionId = coll.body.id as string;

      // Nœud + item écrits directement : ce test porte sur l'export, pas sur l'enrichissement
      // (créer un nœud par l'API déclencherait un snapshot réseau, stubbé ailleurs).
      const node = await prisma.collectionNode.create({
        data: {
          collectionId,
          userId,
          level: 'serie',
          unifiedData: { title: 'Vinland Saga', totalCount: 27 },
          userData: { note: 9, comment: 'chef-d’œuvre' },
          sources: [
            {
              provider: 'mal',
              externalId: '17',
              rawData: null,
              fetchedAt: null,
            },
          ],
          isWishlist: false,
        },
      });
      await prisma.item.create({
        data: {
          collectionId,
          userId,
          nodeId: node.id,
          volume: 1,
          unifiedData: { type: 'manga', title: 'Vinland Saga — T.1' },
          userData: { status: 'WISHLIST', rating: 5 },
          sources: [],
        },
      });

      const exp = await request(app.getHttpServer())
        .get('/v1/me/export')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const { data } = JSON.parse(exp.text);

      expect(data.collections).toHaveLength(1);
      expect(data.collectionNodes).toHaveLength(1);
      expect(data.collectionNodes[0]).toMatchObject({
        id: node.id,
        level: 'serie',
        isWishlist: false,
        unifiedData: { title: 'Vinland Saga', totalCount: 27 },
        userData: { note: 9, comment: 'chef-d’œuvre' },
      });
      expect(data.collectionNodes[0].sources).toHaveLength(1);
      expect(data.items).toHaveLength(1);
      expect(data.items[0]).toMatchObject({
        volume: 1,
        unifiedData: { type: 'manga', title: 'Vinland Saga — T.1' },
        userData: { status: 'WISHLIST', rating: 5 },
      });
    } finally {
      await prisma.user
        .deleteMany({ where: { id: userId } })
        .catch(() => undefined);
      await prisma.auditLog.deleteMany({ where: { userId } });
    }
  });

  it('GET /v1/me sans Authorization → 401 Problem Details', async () => {
    const res = await request(app.getHttpServer()).get('/v1/me').expect(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.type).toContain('/probs/unauthorized');
  });

  it('GET /v1/me avec un Bearer cassé → 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .expect(401);
    expect(res.body.type).toContain('/probs/unauthorized');
  });
});
