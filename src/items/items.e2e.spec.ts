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
import { SourceSnapshotService } from '../common/sources/source-snapshot.service';
import { PrismaService } from '../prisma/prisma.service';

class FakeGoogleProvider {
  readonly name = 'google';
  subject = '';
  verify(_credential: unknown) {
    return Promise.resolve({ subject: this.subject });
  }
}

// Snapshot stubbé : 'mal' renvoie un UnifiedItem manga enrichi, tout autre provider
// une référence sans snapshot (rawData null). Évite tout appel réseau MAL en e2e.
class FakeSnapshots {
  hasAdapter(provider: string): boolean {
    return provider === 'mal';
  }
  snapshot(ref: { provider: string; externalId: string }) {
    if (ref.provider === 'mal') {
      return Promise.resolve({
        provider: 'mal',
        externalId: ref.externalId,
        rawData: {
          source: 'mal',
          sourceId: ref.externalId,
          mediaType: 'manga',
          title: `Serie ${ref.externalId}`,
          creators: ['Eiichiro Oda'],
          description: 'A long synopsis',
          coverUrl: 'https://example.com/cover.jpg',
          metadata: {
            mean: 8.7,
            media_type: 'manga',
            status: 'currently_publishing',
            num_volumes: 108,
          },
          rawData: { id: Number(ref.externalId) || 0 },
        },
        fetchedAt: '2026-05-29T00:00:00.000Z',
      });
    }
    return Promise.resolve({
      provider: ref.provider,
      externalId: ref.externalId,
      rawData: null,
      fetchedAt: null,
    });
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
  // collections + items + nodes + oauthcreds cascade via FK ; audit_logs n'a pas de FK.
  await prisma.user
    .deleteMany({ where: { id: userId } })
    .catch(() => undefined);
  await prisma.auditLog.deleteMany({ where: { userId } });
}

describe('Collections typées / nœuds / sources (e2e) — sprint 03b', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeGoogle: FakeGoogleProvider;

  const createCollection = async (
    token: string,
    typeCode: string,
    name: string,
  ): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/v1/collections')
      .set('Authorization', `Bearer ${token}`)
      .send({ typeCode, name })
      .expect(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GoogleIdentityProvider)
      .useValue(new FakeGoogleProvider())
      .overrideProvider(SourceSnapshotService)
      .useValue(new FakeSnapshots())
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

  it('vinyl (plat) : create → list légère → findOne curé → PATCH → attach source → /sources → delete', async () => {
    const sub = `e2e-vinyl-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      const coll = await createCollection(token, 'vinyl', 'Mes vinyles');

      // Create (pas de node/volume sur un type plat)
      const created = await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          unifiedData: { title: 'Hollow Knight OST', creators: ['Larkin'] },
        })
        .expect(201);
      expect(created.body.nodeId).toBeNull();
      expect(created.body.volume).toBeNull();
      expect(created.body.unifiedData).toMatchObject({
        type: 'vinyl',
        title: 'Hollow Knight OST',
      });
      expect(created.body.sources).toEqual([]);
      const itemId = created.body.id as string;

      // Liste = projection légère vinyl
      const list = await request(app.getHttpServer())
        .get(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(list.body.data[0]).toEqual({
        id: itemId,
        type: 'vinyl',
        title: 'Hollow Knight OST',
        coverUrl: null,
        creators: ['Larkin'],
        genre: [],
        releaseDate: null,
      });

      // PATCH unifiedData (curation)
      const patched = await request(app.getHttpServer())
        .patch(`/v1/items/${itemId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ unifiedData: { title: 'Hollow Knight OST (Deluxe)' } })
        .expect(200);
      expect(patched.body.unifiedData.title).toBe('Hollow Knight OST (Deluxe)');

      // Attach une source isbn (pas d'adapter → réf sans rawData)
      await request(app.getHttpServer())
        .post(`/v1/items/${itemId}/sources`)
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'isbn', externalId: '9782723492607' })
        .expect(201);

      // findOne curé : sources = réfs SANS rawData
      const detail = await request(app.getHttpServer())
        .get(`/v1/items/${itemId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(detail.body.sources).toEqual([
        { provider: 'isbn', externalId: '9782723492607', fetchedAt: null },
      ]);
      expect(detail.body.sources[0].rawData).toBeUndefined();

      // /sources : snapshots bruts (rawData présent, ici null pour une réf)
      const sources = await request(app.getHttpServer())
        .get(`/v1/items/${itemId}/sources`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(sources.body[0]).toMatchObject({
        provider: 'isbn',
        externalId: '9782723492607',
        rawData: null,
      });

      // delete → itemCount décrémenté
      await request(app.getHttpServer())
        .delete(`/v1/items/${itemId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      const after = await request(app.getHttpServer())
        .get(`/v1/collections/${coll}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(after.body.itemCount).toBe(0);
      expect(after.body.hierarchy).toEqual([]); // type plat
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('vinyl autorise les doublons (pas de contrainte nodeId/volume)', async () => {
    const sub = `e2e-vinyl-dup-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    try {
      const coll = await createCollection(token, 'vinyl', 'dups');
      const body = { unifiedData: { title: 'Same' } };
      await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('manga : tome (node+volume) → 201 ; 2× même (node,volume) → 409 ; hierarchy + drill-down + purge', async () => {
    const sub = `e2e-manga-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      const coll = await createCollection(token, 'manga', 'Mes mangas');
      const node = { provider: 'mal', externalId: '13' };

      // T.1
      const t1 = await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({ node, volume: 1, unifiedData: { title: 'One Piece — T.1' } })
        .expect(201);
      expect(t1.body.volume).toBe(1);
      expect(t1.body.nodeId).not.toBeNull();
      const nodeId = t1.body.nodeId as string;

      // T.2 (même série, volume différent)
      await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({ node, volume: 2, unifiedData: {} })
        .expect(201);

      // (node, volume) dupliqué → 409
      const dup = await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({ node, volume: 1, unifiedData: {} });
      expect(dup.status).toBe(409);
      expect(dup.body.type).toContain('/probs/conflict');

      // hierarchy : 1 série
      const detail = await request(app.getHttpServer())
        .get(`/v1/collections/${coll}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(detail.body.hierarchy).toEqual([
        { key: 'serie', label: 'Série', count: 1 },
      ]);

      // nodes : enrichi via MAL, ownedCount=2
      const nodes = await request(app.getHttpServer())
        .get(`/v1/collections/${coll}/nodes?level=serie`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(nodes.body.data).toHaveLength(1);
      expect(nodes.body.data[0]).toMatchObject({
        id: nodeId,
        level: 'serie',
        title: 'Serie 13',
        author: 'Eiichiro Oda',
        status: 'ongoing',
        totalCount: 108,
        rating: 8.7,
        ownedCount: 2,
        isWishlist: false,
      });
      expect(nodes.body.data[0].sources).toEqual([
        {
          provider: 'mal',
          externalId: '13',
          fetchedAt: '2026-05-29T00:00:00.000Z',
        },
      ]);

      // drill-down ?nodeId=
      const drill = await request(app.getHttpServer())
        .get(`/v1/collections/${coll}/items?nodeId=${nodeId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(drill.body.data).toHaveLength(2);
      expect(drill.body.data[0]).toMatchObject({
        type: 'manga',
        serie: 'Serie 13',
      });

      // supprime les 2 tomes → purge du nœud (non-wishlist)
      for (const id of drill.body.data.map((d: { id: string }) => d.id)) {
        await request(app.getHttpServer())
          .delete(`/v1/items/${id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(204);
      }
      await request(app.getHttpServer())
        .get(`/v1/nodes/${nodeId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('manga : ?nodeId interdit n’est pas applicable au vinyl (400) + POST série wishlist conservée', async () => {
    const sub = `e2e-wishlist-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);

    try {
      // vinyl : ?nodeId → 400
      const vinyl = await createCollection(token, 'vinyl', 'flat');
      const bad = await request(app.getHttpServer())
        .get(
          `/v1/collections/${vinyl}/items?nodeId=11111111-1111-4111-1111-111111111111`,
        )
        .set('Authorization', `Bearer ${token}`);
      expect(bad.status).toBe(400);

      // manga : série wishlist (sans tome)
      const manga = await createCollection(token, 'manga', 'wl');
      const created = await request(app.getHttpServer())
        .post(`/v1/collections/${manga}/nodes`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          level: 'serie',
          source: { provider: 'mal', externalId: '21' },
          isWishlist: true,
        })
        .expect(201);
      expect(created.body).toMatchObject({
        level: 'serie',
        title: 'Serie 21',
        totalCount: 108,
        ownedCount: 0,
        isWishlist: true,
      });
      const nodeId = created.body.id as string;

      // conservée malgré ownedCount=0
      await request(app.getHttpServer())
        .get(`/v1/nodes/${nodeId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // PATCH note/comment
      const patched = await request(app.getHttpServer())
        .patch(`/v1/nodes/${nodeId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ note: 5, comment: 'top' })
        .expect(200);
      expect(patched.body.userData).toEqual({ note: 5, comment: 'top' });

      // PATCH isWishlist=false sur nœud vide → 204 purge
      await request(app.getHttpServer())
        .patch(`/v1/nodes/${nodeId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isWishlist: false })
        .expect(204);
      await request(app.getHttpServer())
        .get(`/v1/nodes/${nodeId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('filtre ?provider[in]= sur sources[] des items', async () => {
    const sub = `e2e-provider-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    try {
      const coll = await createCollection(token, 'vinyl', 'prov');
      const withMal = await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          unifiedData: { title: 'A' },
          sources: [{ provider: 'mal', externalId: 'm1' }],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({ unifiedData: { title: 'B' } })
        .expect(201);

      const filtered = await request(app.getHttpServer())
        .get(`/v1/collections/${coll}/items?provider[in]=mal`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(filtered.body.data).toHaveLength(1);
      expect(filtered.body.data[0].id).toBe(withMal.body.id);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('isolation cross-user : B reçoit 404 sur item/nœud de A', async () => {
    const subA = `e2e-iso-A-${randomBytes(8).toString('hex')}`;
    const subB = `e2e-iso-B-${randomBytes(8).toString('hex')}`;
    const a = await login(app, fakeGoogle, subA);
    const b = await login(app, fakeGoogle, subB);

    try {
      const coll = await createCollection(a.token, 'manga', 'A mangas');
      const tome = await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${a.token}`)
        .send({
          node: { provider: 'mal', externalId: '99' },
          volume: 1,
          unifiedData: {},
        })
        .expect(201);

      await request(app.getHttpServer())
        .get(`/v1/items/${tome.body.id}`)
        .set('Authorization', `Bearer ${b.token}`)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/v1/nodes/${tome.body.nodeId}`)
        .set('Authorization', `Bearer ${b.token}`)
        .expect(404);
      await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${b.token}`)
        .send({
          node: { provider: 'mal', externalId: '99' },
          volume: 2,
          unifiedData: {},
        })
        .expect(404);
    } finally {
      await cleanupUser(prisma, a.userId);
      await cleanupUser(prisma, b.userId);
    }
  });

  it('type non implémenté (movie) → POST permissif', async () => {
    const sub = `e2e-movie-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    try {
      const coll = await createCollection(token, 'movie', 'films');
      const created = await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({ unifiedData: { whatever: 'goes', nested: { ok: true } } })
        .expect(201);
      expect(created.body.unifiedData).toMatchObject({ whatever: 'goes' });
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('quota : nœuds non comptés ; seuls les items comptent dans /me/quota', async () => {
    const sub = `e2e-quota-nodes-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    try {
      const coll = await createCollection(token, 'manga', 'q');

      // POST série (nœud) seul → items.used reste 0
      await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/nodes`)
        .set('Authorization', `Bearer ${token}`)
        .send({ level: 'serie', source: { provider: 'mal', externalId: '7' } })
        .expect(201);
      const q1 = await request(app.getHttpServer())
        .get('/v1/me/quota')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(q1.body.items.used).toBe(0);

      // POST tome → items.used = 1
      await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          node: { provider: 'mal', externalId: '7' },
          volume: 1,
          unifiedData: {},
        })
        .expect(201);
      const q2 = await request(app.getHttpServer())
        .get('/v1/me/quota')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(q2.body.items.used).toBe(1);
      expect(q2.body.items.max).toBe(FREE_TIER_LIMITS.items);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });
});
