import { INestApplication, RequestMethod } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { AppModule } from '../app.module';
import { GoogleIdentityProvider } from '../auth/providers/google.provider';
import { ProblemDetailsExceptionFilter } from '../common/filters/problem-details.filter';
import { CorrelationIdInterceptor } from '../common/interceptors/correlation-id.interceptor';
import { FREE_TIER_LIMITS } from '../common/quota/quota.service';
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

async function cleanupUser(
  prisma: PrismaService,
  userId: string,
): Promise<void> {
  // collections + items + oauthcreds cascade via FK ; audit_logs n'a pas de FK.
  await prisma.user
    .deleteMany({ where: { id: userId } })
    .catch(() => undefined);
  await prisma.auditLog.deleteMany({ where: { userId } });
}

describe('Collections + Items (e2e) — sprint 03 Bloc E', () => {
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

  it('flow complet : create collection → add 3 items → list → delete 1 → itemCount=2 → cascade delete', async () => {
    const sub = `e2e-flow-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      // Création de la collection
      const created = await request(app.getHttpServer())
        .post('/v1/collections')
        .set('Authorization', `Bearer ${token}`)
        .send({ typeCode: 'vinyl', name: 'Ma collection vinyl' })
        .expect(201);
      expect(created.body.userId).toBe(userId);
      expect(created.body.typeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.body.itemCount).toBe(0);
      const collectionId = created.body.id as string;

      // Détail = objet brut (pas d'enveloppe { data })
      const detail = await request(app.getHttpServer())
        .get(`/v1/collections/${collectionId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(detail.body.id).toBe(collectionId);
      expect(detail.body.data).toBeUndefined();

      // Ajout de 3 items
      const itemIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await request(app.getHttpServer())
          .post(`/v1/collections/${collectionId}/items`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            source: 'discogs',
            sourceId: `disc-${i}-${randomBytes(4).toString('hex')}`,
            unifiedData: { title: `Title ${i}` },
            rawData: { raw: i },
          })
          .expect(201);
        itemIds.push(res.body.id);
      }

      // itemCount maintenu à 3
      const afterCreate = await request(app.getHttpServer())
        .get(`/v1/collections/${collectionId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(afterCreate.body.itemCount).toBe(3);

      // List items : enveloppe { data, meta.pagination }
      const list = await request(app.getHttpServer())
        .get(`/v1/collections/${collectionId}/items`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(Array.isArray(list.body.data)).toBe(true);
      expect(list.body.data).toHaveLength(3);
      expect(list.body.meta.pagination).toEqual({
        nextCursor: null,
        limit: 50,
      });

      // Detail d'un item
      const itemDetail = await request(app.getHttpServer())
        .get(`/v1/items/${itemIds[0]}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(itemDetail.body.id).toBe(itemIds[0]);
      expect(itemDetail.body.data).toBeUndefined();

      // Suppression d'un item → itemCount décrémenté
      await request(app.getHttpServer())
        .delete(`/v1/items/${itemIds[0]}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      const afterDelete = await request(app.getHttpServer())
        .get(`/v1/collections/${collectionId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(afterDelete.body.itemCount).toBe(2);

      // Cascade : delete collection → tous les items partent
      await request(app.getHttpServer())
        .delete(`/v1/collections/${collectionId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      const orphanItems = await prisma.item.count({
        where: { collectionId },
      });
      expect(orphanItems).toBe(0);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('isolation cross-user : B reçoit 404 (jamais 403) sur les ressources de A', async () => {
    const subA = `e2e-iso-A-${randomBytes(8).toString('hex')}`;
    const subB = `e2e-iso-B-${randomBytes(8).toString('hex')}`;
    const a = await login(app, fakeGoogle, subA);
    const b = await login(app, fakeGoogle, subB);

    try {
      const created = await request(app.getHttpServer())
        .post('/v1/collections')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ typeCode: 'manga', name: 'A’s manga' })
        .expect(201);
      const collectionId = created.body.id as string;

      const item = await request(app.getHttpServer())
        .post(`/v1/collections/${collectionId}/items`)
        .set('Authorization', `Bearer ${a.token}`)
        .send({
          source: 'mal',
          sourceId: `mal-${randomBytes(4).toString('hex')}`,
          unifiedData: {},
          rawData: {},
        })
        .expect(201);
      const itemId = item.body.id as string;

      // B GET la collection de A → 404
      const get = await request(app.getHttpServer())
        .get(`/v1/collections/${collectionId}`)
        .set('Authorization', `Bearer ${b.token}`);
      expect(get.status).toBe(404);
      expect(get.headers['content-type']).toContain('application/problem+json');
      expect(get.body.type).toContain('/probs/not-found');

      // B PATCH la collection de A → 404 (pas 403, pas de leak)
      const patch = await request(app.getHttpServer())
        .patch(`/v1/collections/${collectionId}`)
        .set('Authorization', `Bearer ${b.token}`)
        .send({ name: 'pwn' });
      expect(patch.status).toBe(404);

      // B DELETE l'item de A → 404
      const del = await request(app.getHttpServer())
        .delete(`/v1/items/${itemId}`)
        .set('Authorization', `Bearer ${b.token}`);
      expect(del.status).toBe(404);

      // B POST item dans la collection de A → 404
      const postItem = await request(app.getHttpServer())
        .post(`/v1/collections/${collectionId}/items`)
        .set('Authorization', `Bearer ${b.token}`)
        .send({
          source: 'mal',
          sourceId: 'x',
          unifiedData: {},
          rawData: {},
        });
      expect(postItem.status).toBe(404);

      // Aucune fuite : A n'a pas été muté
      const stillThere = await request(app.getHttpServer())
        .get(`/v1/collections/${collectionId}`)
        .set('Authorization', `Bearer ${a.token}`)
        .expect(200);
      expect(stillThere.body.name).toBe('A’s manga');
    } finally {
      await cleanupUser(prisma, a.userId);
      await cleanupUser(prisma, b.userId);
    }
  });

  it('filtre inconnu (Zod .strict) → 400 Problem Details', async () => {
    const sub = `e2e-strict-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      const res = await request(app.getHttpServer())
        .get('/v1/collections?status=foo')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.type).toContain('/probs/validation-error');
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('filtre type[in] : ne renvoie que les codes demandés', async () => {
    const sub = `e2e-filter-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      const codes = ['vinyl', 'manga', 'movie'] as const;
      for (const code of codes) {
        await request(app.getHttpServer())
          .post('/v1/collections')
          .set('Authorization', `Bearer ${token}`)
          .send({ typeCode: code, name: `${code}-coll` })
          .expect(201);
      }

      const res = await request(app.getHttpServer())
        .get('/v1/collections?type[in]=vinyl,manga')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.data).toHaveLength(2);
      const names = (res.body.data as { name: string }[])
        .map((c) => c.name)
        .sort();
      expect(names).toEqual(['manga-coll', 'vinyl-coll']);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('pagination cursor : 3 collections, limit=1 → walk les pages jusqu’à nextCursor=null', async () => {
    const sub = `e2e-page-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post('/v1/collections')
          .set('Authorization', `Bearer ${token}`)
          .send({ typeCode: 'book', name: `book-${i}` })
          .expect(201);
      }

      // Page 1
      const p1 = await request(app.getHttpServer())
        .get('/v1/collections?limit=1')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(p1.body.data).toHaveLength(1);
      expect(p1.body.meta.pagination.limit).toBe(1);
      expect(p1.body.meta.pagination.nextCursor).not.toBeNull();

      // Page 2
      const p2 = await request(app.getHttpServer())
        .get(
          `/v1/collections?limit=1&cursor=${p1.body.meta.pagination.nextCursor}`,
        )
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(p2.body.data).toHaveLength(1);
      expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id);

      // Page 3 — dernière, nextCursor=null
      const p3 = await request(app.getHttpServer())
        .get(
          `/v1/collections?limit=1&cursor=${p2.body.meta.pagination.nextCursor}`,
        )
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(p3.body.data).toHaveLength(1);
      expect(p3.body.meta.pagination.nextCursor).toBeNull();
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('typeCode inconnu → 400', async () => {
    const sub = `e2e-typecode-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      const res = await request(app.getHttpServer())
        .post('/v1/collections')
        .set('Authorization', `Bearer ${token}`)
        .send({ typeCode: 'inexistant', name: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.type).toMatch(/\/probs\/(bad-request|validation-error)/);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('unicité (source, sourceId) : 2x le même item → 409 conflict', async () => {
    const sub = `e2e-dup-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      const coll = await request(app.getHttpServer())
        .post('/v1/collections')
        .set('Authorization', `Bearer ${token}`)
        .send({ typeCode: 'movie', name: 'movies' })
        .expect(201);
      const collectionId = coll.body.id;

      const sourceId = `tmdb-${randomBytes(4).toString('hex')}`;
      await request(app.getHttpServer())
        .post(`/v1/collections/${collectionId}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          source: 'tmdb',
          sourceId,
          unifiedData: {},
          rawData: {},
        })
        .expect(201);

      const dup = await request(app.getHttpServer())
        .post(`/v1/collections/${collectionId}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          source: 'tmdb',
          sourceId,
          unifiedData: {},
          rawData: {},
        });
      expect(dup.status).toBe(409);
      expect(dup.body.type).toContain('/probs/conflict');
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('quota collections : la (max+1)ème → 403 /probs/quota-exceeded "max N"', async () => {
    const sub = `e2e-quota-coll-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      for (let i = 0; i < FREE_TIER_LIMITS.collections; i++) {
        await request(app.getHttpServer())
          .post('/v1/collections')
          .set('Authorization', `Bearer ${token}`)
          .send({ typeCode: 'game', name: `g-${i}` })
          .expect(201);
      }
      const over = await request(app.getHttpServer())
        .post('/v1/collections')
        .set('Authorization', `Bearer ${token}`)
        .send({ typeCode: 'game', name: 'g-over' });
      expect(over.status).toBe(403);
      expect(over.body.type).toContain('/probs/quota-exceeded');
      expect(over.body.detail).toContain(`max ${FREE_TIER_LIMITS.collections}`);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('quota items : sum(itemCount) == max → POST item → 403 quota-exceeded', async () => {
    const sub = `e2e-quota-items-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      const coll = await request(app.getHttpServer())
        .post('/v1/collections')
        .set('Authorization', `Bearer ${token}`)
        .send({ typeCode: 'vinyl', name: 'soon-full' })
        .expect(201);
      const collectionId = coll.body.id as string;

      // On bump le compteur côté DB pour éviter de créer 500 items dans l'e2e.
      // QuotaService.assertCanCreateItem somme sur collection.itemCount → ce hack
      // suffit pour atteindre la limite.
      await prisma.collection.update({
        where: { id: collectionId },
        data: { itemCount: FREE_TIER_LIMITS.items },
      });

      const over = await request(app.getHttpServer())
        .post(`/v1/collections/${collectionId}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          source: 'discogs',
          sourceId: `over-${randomBytes(4).toString('hex')}`,
          unifiedData: {},
          rawData: {},
        });
      expect(over.status).toBe(403);
      expect(over.body.type).toContain('/probs/quota-exceeded');
      expect(over.body.detail).toContain(`max ${FREE_TIER_LIMITS.items}`);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('GET /v1/me/quota : compteurs cohérents avec l’état réel', async () => {
    const sub = `e2e-me-quota-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      // État initial : 0 / 0
      const initial = await request(app.getHttpServer())
        .get('/v1/me/quota')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(initial.body).toEqual({
        collections: { used: 0, max: FREE_TIER_LIMITS.collections },
        items: { used: 0, max: FREE_TIER_LIMITS.items },
      });

      // 2 collections, 3 items dans la première
      const coll1 = await request(app.getHttpServer())
        .post('/v1/collections')
        .set('Authorization', `Bearer ${token}`)
        .send({ typeCode: 'vinyl', name: 'A' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/v1/collections')
        .set('Authorization', `Bearer ${token}`)
        .send({ typeCode: 'manga', name: 'B' })
        .expect(201);
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post(`/v1/collections/${coll1.body.id}/items`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            source: 'discogs',
            sourceId: `s-${i}-${randomBytes(4).toString('hex')}`,
            unifiedData: {},
            rawData: {},
          })
          .expect(201);
      }

      const after = await request(app.getHttpServer())
        .get('/v1/me/quota')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(after.body.collections.used).toBe(2);
      expect(after.body.items.used).toBe(3);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });
});
