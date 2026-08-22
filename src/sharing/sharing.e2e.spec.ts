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
): Promise<{ token: string; userId: string }> {
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

async function grantPremium(
  prisma: PrismaService,
  userId: string,
): Promise<void> {
  await prisma.premiumGrant.create({
    data: { userId, reason: 'beta_tester', expiresAt: null },
  });
}

async function cleanupUser(
  prisma: PrismaService,
  userId: string,
): Promise<void> {
  // collections -> shares -> members cascadent via FK ; audit_logs n'a pas de FK.
  await prisma.user
    .deleteMany({ where: { id: userId } })
    .catch(() => undefined);
  await prisma.auditLog.deleteMany({ where: { userId } });
}

describe('Partage de collection (e2e) — sprint S3', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeGoogle: FakeGoogleProvider;

  const createCollection = async (token: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/v1/collections')
      .set('Authorization', `Bearer ${token}`)
      .send({ typeCode: 'vinyl', name: 'Vinyles du salon' })
      .expect(201);
    return res.body.id as string;
  };

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

  it('cycle complet : create -> redeem par un membre gratuit -> list -> revoke', async () => {
    const owner = await login(
      app,
      fakeGoogle,
      `e2e-share-owner-${randomBytes(8).toString('hex')}`,
    );
    const member = await login(
      app,
      fakeGoogle,
      `e2e-share-member-${randomBytes(8).toString('hex')}`,
    );

    try {
      await grantPremium(prisma, owner.userId); // le membre reste volontairement gratuit
      const collectionId = await createCollection(owner.token);

      // 1. Le propriétaire crée un partage `owned` : le code sort une seule fois.
      const created = await request(app.getHttpServer())
        .post(`/v1/collections/${collectionId}/shares`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ scope: 'owned', maxUses: 2 })
        .expect(201);

      const shareId = created.body.id as string;
      const code = created.body.code as string;
      expect(code).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(created.body.scope).toBe('owned');
      expect(created.body).not.toHaveProperty('codeHash');

      // 2. Une relecture ne redonne jamais le code.
      const listed = await request(app.getHttpServer())
        .get(`/v1/collections/${collectionId}/shares`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(listed.body).toHaveLength(1);
      expect(JSON.stringify(listed.body)).not.toContain(code);
      expect(listed.body[0].members).toEqual([]);

      // 3. Le propriétaire ne peut pas rejoindre son propre partage.
      await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ code })
        .expect(400);

      // 4. Un compte NON premium rejoint : c'est le propriétaire qui paie le stockage.
      const redeemed = await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ code })
        .expect(200);
      expect(redeemed.body).toMatchObject({
        shareId,
        collectionId,
        scope: 'owned',
        alreadyMember: false,
        collection: {
          id: collectionId,
          name: 'Vinyles du salon',
          type: 'vinyl',
        },
      });

      // 5. Idempotence : re-rejoindre ne consomme pas de place.
      const again = await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ code })
        .expect(200);
      expect(again.body.alreadyMember).toBe(true);

      // 6. Le membre apparaît côté propriétaire, et voit le partage dans ses reçus.
      const afterRedeem = await request(app.getHttpServer())
        .get(`/v1/collections/${collectionId}/shares`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(afterRedeem.body[0].usedCount).toBe(1);
      expect(afterRedeem.body[0].members).toEqual([
        expect.objectContaining({ memberUserId: member.userId }),
      ]);

      const received = await request(app.getHttpServer())
        .get('/v1/shares/received')
        .set('Authorization', `Bearer ${member.token}`)
        .expect(200);
      expect(received.body).toEqual([
        expect.objectContaining({ shareId, collectionId, scope: 'owned' }),
      ]);

      // 7. Après révocation, le code ne prend plus — et sans dire pourquoi.
      await request(app.getHttpServer())
        .delete(`/v1/shares/${shareId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      const third = await login(
        app,
        fakeGoogle,
        `e2e-share-third-${randomBytes(8).toString('hex')}`,
      );
      try {
        const refused = await request(app.getHttpServer())
          .post('/v1/shares/redeem')
          .set('Authorization', `Bearer ${third.token}`)
          .send({ code })
          .expect(404);
        expect(refused.body.type).toContain('share-code-invalid');

        // Un code jamais émis produit exactement la même réponse : aucun oracle d'existence.
        const unknown = await request(app.getHttpServer())
          .post('/v1/shares/redeem')
          .set('Authorization', `Bearer ${third.token}`)
          .send({ code: 'aaaaaaaaaaaaaaaaaaaaaaaa' })
          .expect(404);
        expect(unknown.body.type).toBe(refused.body.type);
        expect(unknown.body.detail).toBe(refused.body.detail);
      } finally {
        await cleanupUser(prisma, third.userId);
      }

      // 8. Le membre révoqué perd le partage dans ses reçus.
      const afterRevoke = await request(app.getHttpServer())
        .get('/v1/shares/received')
        .set('Authorization', `Bearer ${member.token}`)
        .expect(200);
      expect(afterRevoke.body).toEqual([]);

      // 9. Aucun code en clair dans l'audit log.
      const audits = await prisma.auditLog.findMany({
        where: { userId: owner.userId, action: { startsWith: 'share.' } },
      });
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining(['share.create', 'share.revoke']),
      );
      expect(JSON.stringify(audits)).not.toContain(code);
    } finally {
      await cleanupUser(prisma, member.userId);
      await cleanupUser(prisma, owner.userId);
    }
  });

  it('un compte non premium ne peut pas émettre de partage (402)', async () => {
    const owner = await login(
      app,
      fakeGoogle,
      `e2e-share-free-${randomBytes(8).toString('hex')}`,
    );
    try {
      await grantPremium(prisma, owner.userId);
      const collectionId = await createCollection(owner.token);
      // Le premium tombe après coup : la collection existe, le droit d'en émettre un partage non.
      await prisma.premiumGrant.delete({ where: { userId: owner.userId } });

      await request(app.getHttpServer())
        .post(`/v1/collections/${collectionId}/shares`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ scope: 'all' })
        .expect(402);
    } finally {
      await cleanupUser(prisma, owner.userId);
    }
  });

  it('la collection d’autrui reste un 404, pas un 403', async () => {
    const owner = await login(
      app,
      fakeGoogle,
      `e2e-share-a-${randomBytes(8).toString('hex')}`,
    );
    const stranger = await login(
      app,
      fakeGoogle,
      `e2e-share-b-${randomBytes(8).toString('hex')}`,
    );
    try {
      await grantPremium(prisma, owner.userId);
      await grantPremium(prisma, stranger.userId);
      const collectionId = await createCollection(owner.token);

      await request(app.getHttpServer())
        .post(`/v1/collections/${collectionId}/shares`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .send({ scope: 'all' })
        .expect(404);

      await request(app.getHttpServer())
        .get(`/v1/collections/${collectionId}/shares`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(404);
    } finally {
      await cleanupUser(prisma, stranger.userId);
      await cleanupUser(prisma, owner.userId);
    }
  });

  it('un membre éjecté ne revient pas avec le même code, les autres restent', async () => {
    const owner = await login(
      app,
      fakeGoogle,
      `e2e-share-owner2-${randomBytes(8).toString('hex')}`,
    );
    const member = await login(
      app,
      fakeGoogle,
      `e2e-share-member2-${randomBytes(8).toString('hex')}`,
    );
    try {
      await grantPremium(prisma, owner.userId);
      const collectionId = await createCollection(owner.token);

      const created = await request(app.getHttpServer())
        .post(`/v1/collections/${collectionId}/shares`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ scope: 'wantlist', maxUses: 5 })
        .expect(201);
      const { id: shareId, code } = created.body;

      await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ code })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/v1/shares/${shareId}/members/${member.userId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ code })
        .expect(404);

      // Le partage lui-même vit encore : il reste listé, membres actifs vidés.
      const listed = await request(app.getHttpServer())
        .get(`/v1/collections/${collectionId}/shares`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0].members).toEqual([]);
    } finally {
      await cleanupUser(prisma, member.userId);
      await cleanupUser(prisma, owner.userId);
    }
  });

  it('l’export RGPD contient les deux sens du partage, jamais le hash du code', async () => {
    const owner = await login(
      app,
      fakeGoogle,
      `e2e-share-exp-o-${randomBytes(8).toString('hex')}`,
    );
    const member = await login(
      app,
      fakeGoogle,
      `e2e-share-exp-m-${randomBytes(8).toString('hex')}`,
    );
    try {
      await grantPremium(prisma, owner.userId);
      const collectionId = await createCollection(owner.token);
      const created = await request(app.getHttpServer())
        .post(`/v1/collections/${collectionId}/shares`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ scope: 'all' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ code: created.body.code })
        .expect(200);

      const ownerExport = await request(app.getHttpServer())
        .get('/v1/me/export')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      const ownerData = JSON.parse(ownerExport.text).data;
      expect(ownerData.collectionShares).toHaveLength(1);
      expect(ownerData.collectionShares[0]).not.toHaveProperty('codeHash');
      expect(ownerData.collectionShares[0].members).toHaveLength(1);
      expect(ownerData.shareMemberships).toEqual([]);

      const memberExport = await request(app.getHttpServer())
        .get('/v1/me/export')
        .set('Authorization', `Bearer ${member.token}`)
        .expect(200);
      const memberData = JSON.parse(memberExport.text).data;
      expect(memberData.collectionShares).toEqual([]);
      expect(memberData.shareMemberships).toHaveLength(1);
      expect(memberData.shareMemberships[0]).toMatchObject({
        shareId: created.body.id,
        share: { collectionId, scope: 'all' },
      });
    } finally {
      await cleanupUser(prisma, member.userId);
      await cleanupUser(prisma, owner.userId);
    }
  });
});
