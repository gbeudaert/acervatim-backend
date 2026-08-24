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
  // collections -> entries, et shares -> entries/members, cascadent via FK ; audit_logs n'a pas de FK.
  await prisma.user
    .deleteMany({ where: { id: userId } })
    .catch(() => undefined);
  await prisma.auditLog.deleteMany({ where: { userId } });
}

describe('Partage de collection (e2e) — sprints S3 et S5', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeGoogle: FakeGoogleProvider;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const createCollection = async (
    token: string,
    name = 'Vinyles du salon',
  ): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/v1/collections')
      .set(auth(token))
      .send({ typeCode: 'vinyl', name })
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

      // 1. Le propriétaire crée un partage : le code sort une seule fois.
      const created = await request(app.getHttpServer())
        .post('/v1/shares')
        .set(auth(owner.token))
        .send({
          collections: [{ collectionId, statuses: ['OWNED'] }],
          maxUses: 2,
        })
        .expect(201);

      const shareId = created.body.id as string;
      const code = created.body.code as string;
      expect(code).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(created.body.collections).toEqual([
        {
          collectionId,
          name: 'Vinyles du salon',
          type: 'vinyl',
          statuses: ['OWNED'],
        },
      ]);
      expect(created.body).not.toHaveProperty('codeHash');

      // 2. Une relecture ne redonne jamais le code.
      const listed = await request(app.getHttpServer())
        .get('/v1/shares')
        .set(auth(owner.token))
        .expect(200);
      expect(listed.body).toHaveLength(1);
      expect(JSON.stringify(listed.body)).not.toContain(code);
      expect(listed.body[0].members).toEqual([]);

      // 3. Le propriétaire ne peut pas rejoindre son propre partage.
      await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set(auth(owner.token))
        .send({ code })
        .expect(400);

      // 4. Un compte NON premium rejoint : c'est le propriétaire qui paie le stockage.
      const redeemed = await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set(auth(member.token))
        .send({ code })
        .expect(200);
      expect(redeemed.body).toMatchObject({
        shareId,
        alreadyMember: false,
        collections: [
          {
            collectionId,
            name: 'Vinyles du salon',
            type: 'vinyl',
            statuses: ['OWNED'],
            itemCount: 0,
          },
        ],
      });

      // 5. Idempotence : re-rejoindre ne consomme pas de place.
      const again = await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set(auth(member.token))
        .send({ code })
        .expect(200);
      expect(again.body.alreadyMember).toBe(true);

      // 6. Le membre apparaît côté propriétaire, et voit le partage dans ses reçus.
      const afterRedeem = await request(app.getHttpServer())
        .get('/v1/shares')
        .set(auth(owner.token))
        .expect(200);
      expect(afterRedeem.body[0].usedCount).toBe(1);
      expect(afterRedeem.body[0].members).toEqual([
        expect.objectContaining({ memberUserId: member.userId }),
      ]);

      const received = await request(app.getHttpServer())
        .get('/v1/shares/received')
        .set(auth(member.token))
        .expect(200);
      expect(received.body).toEqual([
        expect.objectContaining({
          shareId,
          collections: [expect.objectContaining({ collectionId })],
        }),
      ]);

      // 7. Après révocation, le code ne prend plus — et sans dire pourquoi.
      await request(app.getHttpServer())
        .delete(`/v1/shares/${shareId}`)
        .set(auth(owner.token))
        .expect(204);

      const third = await login(
        app,
        fakeGoogle,
        `e2e-share-third-${randomBytes(8).toString('hex')}`,
      );
      try {
        const refused = await request(app.getHttpServer())
          .post('/v1/shares/redeem')
          .set(auth(third.token))
          .send({ code })
          .expect(404);
        expect(refused.body.type).toContain('share-code-invalid');

        // Un code jamais émis produit exactement la même réponse : aucun oracle d'existence.
        const unknown = await request(app.getHttpServer())
          .post('/v1/shares/redeem')
          .set(auth(third.token))
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
        .set(auth(member.token))
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

  it('un seul code porte plusieurs collections, chacune avec ses propres statuts', async () => {
    const owner = await login(
      app,
      fakeGoogle,
      `e2e-share-multi-o-${randomBytes(8).toString('hex')}`,
    );
    const member = await login(
      app,
      fakeGoogle,
      `e2e-share-multi-m-${randomBytes(8).toString('hex')}`,
    );
    try {
      await grantPremium(prisma, owner.userId);
      const mangas = await createCollection(owner.token, 'Mangas');
      const vinyles = await createCollection(owner.token, 'Vinyles');
      const secrets = await createCollection(owner.token, 'Pas partagee');

      const created = await request(app.getHttpServer())
        .post('/v1/shares')
        .set(auth(owner.token))
        .send({
          label: 'Wantlist manga avec Alice',
          collections: [
            { collectionId: mangas, statuses: ['WISHLIST'] },
            // Combinaison qu'aucune des trois portees de S4 ne savait exprimer.
            { collectionId: vinyles, statuses: ['OWNED', 'WISHLIST'] },
          ],
        })
        .expect(201);

      // Ordre garanti par le nom de collection (Mangas avant Vinyles), pas par l'ordre d'envoi
      // ni par l'UUID : c'est ce que promet ENTRY_INCLUDE.
      expect(created.body.collections).toEqual([
        expect.objectContaining({
          collectionId: mangas,
          name: 'Mangas',
          statuses: ['WISHLIST'],
        }),
        expect.objectContaining({
          collectionId: vinyles,
          name: 'Vinyles',
          statuses: ['OWNED', 'WISHLIST'],
        }),
      ]);

      const received = await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set(auth(member.token))
        .send({ code: created.body.code })
        .expect(200);
      expect(
        (received.body.collections as { collectionId: string }[]).map(
          (c) => c.collectionId,
        ),
      ).toEqual([mangas, vinyles]);

      // La collection laissee hors du partage n'est pas lisible pour autant.
      await request(app.getHttpServer())
        .get(`/v1/collections/${secrets}`)
        .set(auth(member.token))
        .expect(404);

      // Le filtre par collection ne rend que les partages qui l'exposent.
      const onMangas = await request(app.getHttpServer())
        .get(`/v1/shares?collectionId=${mangas}`)
        .set(auth(owner.token))
        .expect(200);
      expect(onMangas.body).toHaveLength(1);

      const onSecrets = await request(app.getHttpServer())
        .get(`/v1/shares?collectionId=${secrets}`)
        .set(auth(owner.token))
        .expect(200);
      expect(onSecrets.body).toEqual([]);
    } finally {
      await cleanupUser(prisma, member.userId);
      await cleanupUser(prisma, owner.userId);
    }
  });

  it('chacun nomme le partage pour soi, et ne voit pas le nom de l’autre', async () => {
    const owner = await login(
      app,
      fakeGoogle,
      `e2e-share-lbl-o-${randomBytes(8).toString('hex')}`,
    );
    const member = await login(
      app,
      fakeGoogle,
      `e2e-share-lbl-m-${randomBytes(8).toString('hex')}`,
    );
    try {
      await grantPremium(prisma, owner.userId);
      const collectionId = await createCollection(owner.token);

      const created = await request(app.getHttpServer())
        .post('/v1/shares')
        .set(auth(owner.token))
        .send({
          label: 'Wantlist manga avec Alice',
          collections: [{ collectionId, statuses: ['WISHLIST'] }],
        })
        .expect(201);
      const shareId = created.body.id as string;
      expect(created.body.label).toBe('Wantlist manga avec Alice');

      const redeemed = await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set(auth(member.token))
        .send({ code: created.body.code, label: 'Wantlist manga de Bob' })
        .expect(200);
      expect(redeemed.body.label).toBe('Wantlist manga de Bob');
      // Le libelle du proprietaire ne franchit jamais la frontiere.
      expect(JSON.stringify(redeemed.body)).not.toContain('Alice');

      const received = await request(app.getHttpServer())
        .get('/v1/shares/received')
        .set(auth(member.token))
        .expect(200);
      expect(received.body[0].label).toBe('Wantlist manga de Bob');
      expect(JSON.stringify(received.body)).not.toContain('Alice');

      // Symetriquement, le proprietaire ne voit pas le nom que le membre lui donne.
      const listed = await request(app.getHttpServer())
        .get('/v1/shares')
        .set(auth(owner.token))
        .expect(200);
      expect(listed.body[0].label).toBe('Wantlist manga avec Alice');
      expect(JSON.stringify(listed.body)).not.toContain('Bob');

      // Chacun renomme le sien.
      const renamedOwner = await request(app.getHttpServer())
        .patch(`/v1/shares/${shareId}`)
        .set(auth(owner.token))
        .send({ label: 'Wantlist manga avec Alice et Charlie' })
        .expect(200);
      expect(renamedOwner.body.label).toBe(
        'Wantlist manga avec Alice et Charlie',
      );

      const renamedMember = await request(app.getHttpServer())
        .patch(`/v1/shares/received/${shareId}`)
        .set(auth(member.token))
        .send({ label: 'Full collection Charlie' })
        .expect(200);
      expect(renamedMember.body.label).toBe('Full collection Charlie');

      // Un libelle vide efface au lieu de stocker une chaine vide.
      const cleared = await request(app.getHttpServer())
        .patch(`/v1/shares/${shareId}`)
        .set(auth(owner.token))
        .send({ label: '   ' })
        .expect(200);
      expect(cleared.body.label).toBeNull();

      // Aucun libelle dans l'audit : il nomme des gens.
      const audits = await prisma.auditLog.findMany({
        where: { userId: owner.userId },
      });
      expect(JSON.stringify(audits)).not.toContain('Alice');
    } finally {
      await cleanupUser(prisma, member.userId);
      await cleanupUser(prisma, owner.userId);
    }
  });

  it('un utilisateur crée autant de partages qu’il veut de la même collection', async () => {
    const owner = await login(
      app,
      fakeGoogle,
      `e2e-share-many-${randomBytes(8).toString('hex')}`,
    );
    try {
      await grantPremium(prisma, owner.userId);
      const collectionId = await createCollection(owner.token);

      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post('/v1/shares')
          .set(auth(owner.token))
          .send({
            label: `Partage ${i}`,
            collections: [{ collectionId, statuses: ['OWNED'] }],
          })
          .expect(201);
      }

      const listed = await request(app.getHttpServer())
        .get('/v1/shares')
        .set(auth(owner.token))
        .expect(200);
      expect(listed.body).toHaveLength(5);
    } finally {
      await cleanupUser(prisma, owner.userId);
    }
  });

  it('refuse un partage mal formé : collection dupliquée, statuts vides', async () => {
    const owner = await login(
      app,
      fakeGoogle,
      `e2e-share-bad-${randomBytes(8).toString('hex')}`,
    );
    try {
      await grantPremium(prisma, owner.userId);
      const collectionId = await createCollection(owner.token);

      await request(app.getHttpServer())
        .post('/v1/shares')
        .set(auth(owner.token))
        .send({
          collections: [
            { collectionId, statuses: ['OWNED'] },
            { collectionId, statuses: ['WISHLIST'] },
          ],
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/v1/shares')
        .set(auth(owner.token))
        .send({ collections: [{ collectionId, statuses: [] }] })
        .expect(400);

      await request(app.getHttpServer())
        .post('/v1/shares')
        .set(auth(owner.token))
        .send({ collections: [] })
        .expect(400);

      // Les portees de S4 ne sont plus un vocabulaire du serveur.
      await request(app.getHttpServer())
        .post('/v1/shares')
        .set(auth(owner.token))
        .send({ collections: [{ collectionId, statuses: ['wantlist'] }] })
        .expect(400);
    } finally {
      await cleanupUser(prisma, owner.userId);
    }
  });

  it('un compte non premium ne peut pas émettre de partage (402), mais garde la main sur les siens', async () => {
    const owner = await login(
      app,
      fakeGoogle,
      `e2e-share-free-${randomBytes(8).toString('hex')}`,
    );
    try {
      await grantPremium(prisma, owner.userId);
      const collectionId = await createCollection(owner.token);
      const created = await request(app.getHttpServer())
        .post('/v1/shares')
        .set(auth(owner.token))
        .send({ collections: [{ collectionId, statuses: ['OWNED'] }] })
        .expect(201);

      // Le premium tombe après coup : la collection existe, le droit d'émettre non.
      await prisma.premiumGrant.delete({ where: { userId: owner.userId } });

      await request(app.getHttpServer())
        .post('/v1/shares')
        .set(auth(owner.token))
        .send({ collections: [{ collectionId, statuses: ['OWNED'] }] })
        .expect(402);

      // Mais il doit pouvoir constater et retirer ce qu'il a déjà partagé.
      await request(app.getHttpServer())
        .get('/v1/shares')
        .set(auth(owner.token))
        .expect(200);
      await request(app.getHttpServer())
        .delete(`/v1/shares/${created.body.id}`)
        .set(auth(owner.token))
        .expect(204);
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
        .post('/v1/shares')
        .set(auth(stranger.token))
        .send({ collections: [{ collectionId, statuses: ['OWNED'] }] })
        .expect(404);

      await request(app.getHttpServer())
        .get(`/v1/shares?collectionId=${collectionId}`)
        .set(auth(stranger.token))
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
        .post('/v1/shares')
        .set(auth(owner.token))
        .send({
          collections: [{ collectionId, statuses: ['WISHLIST'] }],
          maxUses: 5,
        })
        .expect(201);
      const { id: shareId, code } = created.body;

      await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set(auth(member.token))
        .send({ code })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/v1/shares/${shareId}/members/${member.userId}`)
        .set(auth(owner.token))
        .expect(204);

      await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set(auth(member.token))
        .send({ code })
        .expect(404);

      // Le partage lui-même vit encore : il reste listé, membres actifs vidés.
      const listed = await request(app.getHttpServer())
        .get('/v1/shares')
        .set(auth(owner.token))
        .expect(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0].members).toEqual([]);

      // Et le membre éjecté ne peut plus renommer ce qu'il ne détient plus.
      await request(app.getHttpServer())
        .patch(`/v1/shares/received/${shareId}`)
        .set(auth(member.token))
        .send({ label: 'toujours la ?' })
        .expect(404);
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
        .post('/v1/shares')
        .set(auth(owner.token))
        .send({
          label: 'Partage avec Alice',
          collections: [{ collectionId, statuses: ['OWNED', 'WISHLIST'] }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post('/v1/shares/redeem')
        .set(auth(member.token))
        .send({ code: created.body.code, label: 'Chez Alice' })
        .expect(200);

      const ownerExport = await request(app.getHttpServer())
        .get('/v1/me/export')
        .set(auth(owner.token))
        .expect(200);
      const ownerData = JSON.parse(ownerExport.text).data;
      expect(ownerData.collectionShares).toHaveLength(1);
      expect(ownerData.collectionShares[0]).not.toHaveProperty('codeHash');
      // Son libelle est sa donnee : il sort dans SON export.
      expect(ownerData.collectionShares[0].label).toBe('Partage avec Alice');
      expect(ownerData.collectionShares[0].entries).toEqual([
        { collectionId, statuses: ['OWNED', 'WISHLIST'] },
      ]);
      expect(ownerData.collectionShares[0].members).toHaveLength(1);
      expect(ownerData.shareMemberships).toEqual([]);
      // ... mais pas celui du membre.
      expect(JSON.stringify(ownerData)).not.toContain('Chez Alice');

      const memberExport = await request(app.getHttpServer())
        .get('/v1/me/export')
        .set(auth(member.token))
        .expect(200);
      const memberData = JSON.parse(memberExport.text).data;
      expect(memberData.collectionShares).toEqual([]);
      expect(memberData.shareMemberships).toHaveLength(1);
      expect(memberData.shareMemberships[0]).toMatchObject({
        shareId: created.body.id,
        label: 'Chez Alice',
        share: {
          entries: [{ collectionId, statuses: ['OWNED', 'WISHLIST'] }],
        },
      });
      expect(JSON.stringify(memberData)).not.toContain('Partage avec Alice');
    } finally {
      await cleanupUser(prisma, member.userId);
      await cleanupUser(prisma, owner.userId);
    }
  });
});
