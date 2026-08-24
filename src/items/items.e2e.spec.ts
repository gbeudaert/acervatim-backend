import { INestApplication, RequestMethod } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { AppModule } from '../app.module';
import { GoogleIdentityProvider } from '../auth/providers/google.provider';
import { ProblemDetailsExceptionFilter } from '../common/filters/problem-details.filter';
import { CorrelationIdInterceptor } from '../common/interceptors/correlation-id.interceptor';
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

/**
 * Depuis S2 la synchronisation est premium-only : sans grant, toutes les routes
 * `collections`/`items`/`nodes` repondent 402. Les scenarios ci-dessous testent le comportement
 * metier, pas le gate — ils se donnent donc le premium (le gate a ses tests dedies).
 */
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
    await grantPremium(prisma, userId);

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
        status: 'OWNED', // défaut serveur : userData.status absent
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
    await grantPremium(prisma, userId);
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
    await grantPremium(prisma, userId);

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
    await grantPremium(prisma, userId);

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

  it('manga saisi a la main : serie sans provider, tomes par nodeId, deplacement et purge', async () => {
    const sub = `e2e-manga-manuel-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    await grantPremium(prisma, userId);

    try {
      const coll = await createCollection(token, 'manga', 'Saisie manuelle');

      // 1. Serie saisie a la main : aucune reference provider, seulement la verite curee.
      const serie = await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/nodes`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          level: 'serie',
          unifiedData: {
            title: 'Vinland Saga',
            author: 'Makoto Yukimura',
            status: 'ongoing',
            totalCount: 27,
          },
        })
        .expect(201);
      expect(serie.body).toMatchObject({
        level: 'serie',
        title: 'Vinland Saga',
        author: 'Makoto Yukimura',
        status: 'ongoing',
        totalCount: 27,
        ownedCount: 0,
        sources: [],
      });
      const serieId = serie.body.id as string;

      // 2. Tome rattache par nodeId (chemin de la synchronisation : noeuds puis items).
      const t1 = await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          nodeId: serieId,
          volume: 1,
          unifiedData: { title: 'Vinland Saga - T.1', publisherFr: 'Kurokawa' },
        })
        .expect(201);
      expect(t1.body).toMatchObject({ nodeId: serieId, volume: 1 });

      // 3. Tome hors numerotation dans la meme serie (artbook) : volume null accepte.
      await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          nodeId: serieId,
          volume: null,
          unifiedData: { title: 'Artbook' },
        })
        .expect(201);

      // 4. Serie d'un autre compte / hors collection : 404, jamais 400.
      const otherColl = await createCollection(token, 'manga', 'autre');
      await request(app.getHttpServer())
        .post(`/v1/collections/${otherColl}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({ nodeId: serieId, volume: 1, unifiedData: {} })
        .expect(404);

      // 5. La serie se relit avec ses tomes.
      const nodes = await request(app.getHttpServer())
        .get(`/v1/collections/${coll}/nodes?level=serie`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(nodes.body.data).toHaveLength(1);
      expect(nodes.body.data[0]).toMatchObject({
        id: serieId,
        title: 'Vinland Saga',
        ownedCount: 2,
      });

      // 6. Le tome est detache (serie supprimee cote app) puis le second aussi : purge.
      await request(app.getHttpServer())
        .patch(`/v1/items/${t1.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ nodeId: null })
        .expect(200);
      const drill = await request(app.getHttpServer())
        .get(`/v1/collections/${coll}/items?nodeId=${serieId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(drill.body.data).toHaveLength(1);

      await request(app.getHttpServer())
        .patch(`/v1/items/${drill.body.data[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ nodeId: null })
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/nodes/${serieId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      // 7. Une serie sans identite ni contenu curé n'a rien a decrire : 400.
      const empty = await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/nodes`)
        .set('Authorization', `Bearer ${token}`)
        .send({ level: 'serie' });
      expect(empty.status).toBe(400);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('filtre ?provider[in]= sur sources[] des items', async () => {
    const sub = `e2e-provider-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    await grantPremium(prisma, userId);
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

  // S1bis — le serveur doit être un miroir intégral : ce qui entre ressort à l'identique.
  it('round-trip vinyl : un item avec TOUS les champs se relit sans perte', async () => {
    const sub = `e2e-roundtrip-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    await grantPremium(prisma, userId);
    try {
      const coll = await createCollection(token, 'vinyl', 'miroir');
      const unifiedData = {
        title: 'Kind of Blue',
        creators: ['Miles Davis', 'John Coltrane'],
        genre: ['Jazz', 'Modal'],
        label: 'Columbia',
        format: 'LP',
        recordingSpeed: 'RPM_33',
        country: 'US',
        releaseDate: '1959-08-17',
        coverUrl: 'https://example.test/kob.jpg',
      };
      const userData = {
        rating: 5,
        purchasePrice: 34.9,
        lastPlayedAt: '2026-08-01T20:30:00.000Z',
        note: 'Pressage original, pochette usée',
        status: 'OWNED',
      };
      const created = await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          unifiedData,
          userData,
          sources: [
            { provider: 'barcode', externalId: '0888072024557' },
            { provider: 'discogs', externalId: '1234567' },
          ],
        })
        .expect(201);
      const itemId = created.body.id as string;

      const reread = await request(app.getHttpServer())
        .get(`/v1/items/${itemId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // `type` est ajouté par le profil ; tout le reste doit revenir tel quel.
      expect(reread.body.unifiedData).toEqual({
        type: 'vinyl',
        ...unifiedData,
      });
      expect(reread.body.userData).toEqual(userData);
      // Le code-barres vit dans sources[], sa seule source de vérité (S1bis).
      expect(reread.body.sources).toEqual([
        { provider: 'barcode', externalId: '0888072024557', fetchedAt: null },
        { provider: 'discogs', externalId: '1234567', fetchedAt: null },
      ]);

      // Un PATCH d'un seul champ curé ne doit rien emporter d'autre.
      await request(app.getHttpServer())
        .patch(`/v1/items/${itemId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ unifiedData: { ...unifiedData, label: 'Columbia (reissue)' } })
        .expect(200);
      const after = await request(app.getHttpServer())
        .get(`/v1/items/${itemId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(after.body.unifiedData).toEqual({
        type: 'vinyl',
        ...unifiedData,
        label: 'Columbia (reissue)',
      });
      expect(after.body.userData).toEqual(userData);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('releaseDate : un push qui ne connaît que l’année ne dégrade pas une date précise', async () => {
    const sub = `e2e-releasedate-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    await grantPremium(prisma, userId);
    try {
      const coll = await createCollection(token, 'vinyl', 'dates');
      const created = await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          unifiedData: { title: 'Kind of Blue', releaseDate: '1959-08-17' },
        })
        .expect(201);
      const itemId = created.body.id as string;

      // L'app repousse "%04d-01-01" : la date précise est conservée.
      const patched = await request(app.getHttpServer())
        .patch(`/v1/items/${itemId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          unifiedData: { title: 'Kind of Blue', releaseDate: '1959-01-01' },
        })
        .expect(200);
      expect(patched.body.unifiedData.releaseDate).toBe('1959-08-17');

      // Changer d'année reste un vrai changement : il passe.
      const moved = await request(app.getHttpServer())
        .patch(`/v1/items/${itemId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          unifiedData: { title: 'Kind of Blue', releaseDate: '1960-01-01' },
        })
        .expect(200);
      expect(moved.body.unifiedData.releaseDate).toBe('1960-01-01');
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('round-trip nœud série : note/comment se relisent, bornes du schéma appliquées', async () => {
    const sub = `e2e-node-roundtrip-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    await grantPremium(prisma, userId);
    try {
      const coll = await createCollection(token, 'manga', 'séries');
      const created = await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/nodes`)
        .set('Authorization', `Bearer ${token}`)
        .send({ level: 'serie', source: { provider: 'mal', externalId: '31' } })
        .expect(201);
      const nodeId = created.body.id as string;

      await request(app.getHttpServer())
        .patch(`/v1/nodes/${nodeId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ note: 9, comment: 'À relire' })
        .expect(200);
      const reread = await request(app.getHttpServer())
        .get(`/v1/nodes/${nodeId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(reread.body.userData).toEqual({ note: 9, comment: 'À relire' });
      // Les champs curés de la série survivent au PATCH userData.
      expect(reread.body).toMatchObject({ title: 'Serie 31', totalCount: 108 });

      // Un PATCH du seul commentaire ne doit pas effacer la note (merge partiel).
      await request(app.getHttpServer())
        .patch(`/v1/nodes/${nodeId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ comment: 'Relu' })
        .expect(200);
      const merged = await request(app.getHttpServer())
        .get(`/v1/nodes/${nodeId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(merged.body.userData).toEqual({ note: 9, comment: 'Relu' });

      // Bornes du schéma (note 0..10) : 400 Problem Details au-delà.
      const bad = await request(app.getHttpServer())
        .patch(`/v1/nodes/${nodeId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ note: 11 });
      expect(bad.status).toBe(400);
      expect(bad.body.type).toContain('/probs/validation-error');
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('userData.status : PATCH → relecture, merge partiel préservé, valeur inconnue rejetée', async () => {
    const sub = `e2e-status-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    await grantPremium(prisma, userId);
    try {
      const coll = await createCollection(token, 'vinyl', 'statuts');
      const created = await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({ unifiedData: { title: 'Wanted' } })
        .expect(201);
      const itemId = created.body.id as string;
      // Item créé sans status : relu sans erreur, projeté OWNED.
      expect(created.body.userData.status).toBeUndefined();

      // PATCH status → relecture
      await request(app.getHttpServer())
        .patch(`/v1/items/${itemId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userData: { status: 'WISHLIST' } })
        .expect(200);
      const detail = await request(app.getHttpServer())
        .get(`/v1/items/${itemId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(detail.body.userData.status).toBe('WISHLIST');

      // La liste expose le statut (S4 filtrera dessus sans re-fetch)
      const list = await request(app.getHttpServer())
        .get(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(list.body.data[0].status).toBe('WISHLIST');

      // PATCH d'un autre champ : le status ne doit pas être effacé (merge partiel)
      const patched = await request(app.getHttpServer())
        .patch(`/v1/items/${itemId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userData: { rating: 4 } })
        .expect(200);
      expect(patched.body.userData).toMatchObject({
        status: 'WISHLIST',
        rating: 4,
      });

      // Valeur hors enum → 400 Problem Details
      const bad = await request(app.getHttpServer())
        .patch(`/v1/items/${itemId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userData: { status: 'FOO' } });
      expect(bad.status).toBe(400);
      expect(bad.body.type).toContain('/probs/validation-error');
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  it('isolation cross-user : B reçoit 404 sur item/nœud de A', async () => {
    const subA = `e2e-iso-A-${randomBytes(8).toString('hex')}`;
    const subB = `e2e-iso-B-${randomBytes(8).toString('hex')}`;
    const a = await login(app, fakeGoogle, subA);
    const b = await login(app, fakeGoogle, subB);
    await grantPremium(prisma, a.userId);
    await grantPremium(prisma, b.userId);

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
    await grantPremium(prisma, userId);
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

  it('un nœud ne compte pas comme un item : itemCount ne bouge qu’au tome', async () => {
    const sub = `e2e-itemcount-nodes-${randomBytes(8).toString('hex')}`;
    const { token, userId } = await login(app, fakeGoogle, sub);
    await grantPremium(prisma, userId);
    try {
      const coll = await createCollection(token, 'manga', 'q');

      // POST série (nœud) seul → itemCount reste 0
      await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/nodes`)
        .set('Authorization', `Bearer ${token}`)
        .send({ level: 'serie', source: { provider: 'mal', externalId: '7' } })
        .expect(201);
      const c1 = await request(app.getHttpServer())
        .get(`/v1/collections/${coll}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(c1.body.itemCount).toBe(0);

      // POST tome → itemCount = 1
      await request(app.getHttpServer())
        .post(`/v1/collections/${coll}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          node: { provider: 'mal', externalId: '7' },
          volume: 1,
          unifiedData: {},
        })
        .expect(201);
      const c2 = await request(app.getHttpServer())
        .get(`/v1/collections/${coll}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(c2.body.itemCount).toBe(1);
    } finally {
      await cleanupUser(prisma, userId);
    }
  });

  // ---- S2 : la synchronisation est premium-only -----------------------------------------

  describe('gate premium (S2)', () => {
    it('sans premium : 402 sur toute ecriture ET sur toute lecture de ses propres donnees', async () => {
      const sub = `e2e-gate-free-${randomBytes(8).toString('hex')}`;
      const { token, userId } = await login(app, fakeGoogle, sub);
      try {
        // Ecriture : POST /collections
        const created = await request(app.getHttpServer())
          .post('/v1/collections')
          .set('Authorization', `Bearer ${token}`)
          .send({ typeCode: 'vinyl', name: 'refusee' });
        expect(created.status).toBe(402);
        expect(created.body.type).toContain('/probs/payment-required');
        expect(created.headers['content-type']).toContain(
          'application/problem+json',
        );

        // Lecture : la liste de ses propres collections
        const list = await request(app.getHttpServer())
          .get('/v1/collections')
          .set('Authorization', `Bearer ${token}`);
        expect(list.status).toBe(402);

        // Rien n'a ete cree : le refus precede l'ecriture.
        expect(await prisma.collection.count({ where: { userId } })).toBe(0);
      } finally {
        await cleanupUser(prisma, userId);
      }
    });

    it('la perte du premium coupe l’acces a des donnees deja synchronisees', async () => {
      const sub = `e2e-gate-lapse-${randomBytes(8).toString('hex')}`;
      const { token, userId } = await login(app, fakeGoogle, sub);
      await grantPremium(prisma, userId);
      try {
        const coll = await createCollection(token, 'vinyl', 'avant');
        const item = await request(app.getHttpServer())
          .post(`/v1/collections/${coll}/items`)
          .set('Authorization', `Bearer ${token}`)
          .send({ unifiedData: { title: 'A' } })
          .expect(201);
        const itemId = item.body.id as string;

        // Le premium expire.
        await prisma.premiumGrant.delete({ where: { userId } });

        // Thunks, pas des requetes deja construites : supertest ouvre un serveur
        // ephemere par requete, les batir toutes d'avance les fait se fermer entre elles.
        const calls: (() => request.Test)[] = [
          () => request(app.getHttpServer()).get(`/v1/collections/${coll}`),
          () =>
            request(app.getHttpServer()).get(`/v1/collections/${coll}/items`),
          () => request(app.getHttpServer()).get(`/v1/items/${itemId}`),
          () => request(app.getHttpServer()).get(`/v1/items/${itemId}/sources`),
          () =>
            request(app.getHttpServer())
              .patch(`/v1/items/${itemId}`)
              .send({ unifiedData: { title: 'B' } }),
          () => request(app.getHttpServer()).delete(`/v1/items/${itemId}`),
        ];
        for (const call of calls) {
          const res = await call().set('Authorization', `Bearer ${token}`);
          expect(res.status).toBe(402);
        }

        // Les donnees sont intactes : le gate refuse l'acces, il ne supprime rien.
        expect(await prisma.item.count({ where: { userId } })).toBe(1);
      } finally {
        await cleanupUser(prisma, userId);
      }
    });

    it('le gate de lecture regarde le PROPRIETAIRE, pas le requerant (socle S4)', async () => {
      const subOwner = `e2e-gate-owner-${randomBytes(8).toString('hex')}`;
      const subOther = `e2e-gate-other-${randomBytes(8).toString('hex')}`;
      const owner = await login(app, fakeGoogle, subOwner);
      const other = await login(app, fakeGoogle, subOther);
      await grantPremium(prisma, owner.userId);
      try {
        const coll = await createCollection(owner.token, 'vinyl', 'a moi');

        // Le proprietaire est premium : il lit.
        await request(app.getHttpServer())
          .get(`/v1/collections/${coll}`)
          .set('Authorization', `Bearer ${owner.token}`)
          .expect(200);

        // Un tiers non-premium : 404, pas 402 — on ne confirme pas l'existence
        // d'une collection d'autrui (le partage, qui donnera un 200 ici, viendra en S4).
        await request(app.getHttpServer())
          .get(`/v1/collections/${coll}`)
          .set('Authorization', `Bearer ${other.token}`)
          .expect(404);
      } finally {
        await cleanupUser(prisma, owner.userId);
        await cleanupUser(prisma, other.userId);
      }
    });

    it('un identifiant malforme reste un 400, le guard ne le transforme pas en 404', async () => {
      const sub = `e2e-gate-uuid-${randomBytes(8).toString('hex')}`;
      const { token, userId } = await login(app, fakeGoogle, sub);
      await grantPremium(prisma, userId);
      try {
        await request(app.getHttpServer())
          .get('/v1/items/pas-un-uuid')
          .set('Authorization', `Bearer ${token}`)
          .expect(400);
      } finally {
        await cleanupUser(prisma, userId);
      }
    });

    it('GET /v1/me/quota n’existe plus (plafond technique non expose)', async () => {
      const sub = `e2e-gate-noquota-${randomBytes(8).toString('hex')}`;
      const { token, userId } = await login(app, fakeGoogle, sub);
      try {
        await request(app.getHttpServer())
          .get('/v1/me/quota')
          .set('Authorization', `Bearer ${token}`)
          .expect(404);
      } finally {
        await cleanupUser(prisma, userId);
      }
    });
  });
});
