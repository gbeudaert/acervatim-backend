import { INestApplication, RequestMethod } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes } from 'crypto';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { AppModule } from '../app.module';
import { GoogleIdentityProvider } from '../auth/providers/google.provider';
import { ProblemDetailsExceptionFilter } from '../common/filters/problem-details.filter';
import { CorrelationIdInterceptor } from '../common/interceptors/correlation-id.interceptor';
import { SourceSnapshotService } from '../common/sources/source-snapshot.service';
import { PrismaService } from '../prisma/prisma.service';
import { ALL_SHARE_STATUSES, ShareStatus } from './share-statuses';

class FakeGoogleProvider {
  readonly name = 'google';
  subject = '';
  verify(_credential: unknown) {
    return Promise.resolve({ subject: this.subject });
  }
}

// Snapshot stubbe : 'mal' renvoie une serie manga enrichie, tout autre provider une reference
// sans snapshot. Aucun appel reseau en e2e.
class FakeSnapshots {
  hasAdapter(provider: string): boolean {
    return provider === 'mal';
  }
  snapshot(ref: { provider: string; externalId: string }) {
    if (ref.provider !== 'mal') {
      return Promise.resolve({
        provider: ref.provider,
        externalId: ref.externalId,
        rawData: null,
        fetchedAt: null,
      });
    }
    return Promise.resolve({
      provider: 'mal',
      externalId: ref.externalId,
      rawData: {
        source: 'mal',
        sourceId: ref.externalId,
        mediaType: 'manga',
        title: `Serie ${ref.externalId}`,
        creators: ['Eiichiro Oda'],
        description: 'Un synopsis',
        coverUrl: 'https://example.com/cover.jpg',
        metadata: {
          mean: 8.7,
          status: 'currently_publishing',
          num_volumes: 10,
        },
        rawData: { id: Number(ref.externalId) || 0 },
      },
      fetchedAt: '2026-08-22T00:00:00.000Z',
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
  await prisma.user
    .deleteMany({ where: { id: userId } })
    .catch(() => undefined);
  await prisma.auditLog.deleteMany({ where: { userId } });
}

/**
 * Lecture partagee et filtrage par statuts (S4, revu en S5).
 *
 * Le decor est le meme pour tous les scenarios : une collection manga du proprietaire, contenant
 * de quoi distinguer les jeux de statuts.
 *
 *   Serie A (mal:1) --+-- tome 1  OWNED
 *                     +-- tome 2  WISHLIST
 *   Serie B (mal:2) --+-- tome 1  IGNORED      (visible en `all` seulement)
 *   Serie C (mal:3)      aucun tome, isWishlist -> n'existe que pour `wantlist`
 */
describe('Lecture partagee et statuts exposes (e2e) - sprints S4 et S5', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeGoogle: FakeGoogleProvider;

  interface Decor {
    owner: { token: string; userId: string };
    member: { token: string; userId: string };
    collectionId: string;
    shareId: string;
    owned1: string;
    wish2: string;
    ignored1: string;
    serieA: string;
    serieC: string;
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const createItem = async (
    token: string,
    collectionId: string,
    serie: string,
    volume: number,
    status: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string; nodeId: string }> => {
    const res = await request(app.getHttpServer())
      .post(`/v1/collections/${collectionId}/items`)
      .set(auth(token))
      .send({
        node: { provider: 'mal', externalId: serie },
        volume,
        unifiedData: { title: `Serie ${serie} T.${volume}` },
        userData: { status, ...extra },
      })
      .expect(201);
    return { id: res.body.id as string, nodeId: res.body.nodeId as string };
  };

  /** Monte le decor et emet un partage exposant ces statuts, deja rejoint par le membre. */
  const setup = async (statuses: readonly ShareStatus[]): Promise<Decor> => {
    const tag = randomBytes(6).toString('hex');
    const owner = await login(app, fakeGoogle, `e2e-s4-owner-${tag}`);
    const member = await login(app, fakeGoogle, `e2e-s4-member-${tag}`);
    await grantPremium(prisma, owner.userId); // le membre reste gratuit, expres

    const coll = await request(app.getHttpServer())
      .post('/v1/collections')
      .set(auth(owner.token))
      .send({ typeCode: 'manga', name: 'Mangas du salon' })
      .expect(201);
    const collectionId = coll.body.id as string;

    const t1 = await createItem(owner.token, collectionId, '1', 1, 'OWNED', {
      purchasePrice: 12.5,
      note: 'offert par mamie',
      rating: 4,
    });
    const t2 = await createItem(owner.token, collectionId, '1', 2, 'WISHLIST');
    const b1 = await createItem(owner.token, collectionId, '2', 1, 'IGNORED');

    // Serie desiree dont aucun tome n'est encore possede.
    const serieC = await request(app.getHttpServer())
      .post(`/v1/collections/${collectionId}/nodes`)
      .set(auth(owner.token))
      .send({
        level: 'serie',
        source: { provider: 'mal', externalId: '3' },
        isWishlist: true,
      })
      .expect(201);

    const share = await request(app.getHttpServer())
      .post('/v1/shares')
      .set(auth(owner.token))
      .send({ collections: [{ collectionId, statuses }] })
      .expect(201);

    await request(app.getHttpServer())
      .post('/v1/shares/redeem')
      .set(auth(member.token))
      .send({ code: share.body.code })
      .expect(200);

    return {
      owner,
      member,
      collectionId,
      shareId: share.body.id as string,
      owned1: t1.id,
      wish2: t2.id,
      ignored1: b1.id,
      serieA: t1.nodeId,
      serieC: serieC.body.id as string,
    };
  };

  const teardown = async (d: Decor) => {
    await cleanupUser(prisma, d.owner.userId);
    await cleanupUser(prisma, d.member.userId);
  };

  const itemIds = async (token: string, collectionId: string) => {
    const res = await request(app.getHttpServer())
      .get(`/v1/collections/${collectionId}/items`)
      .set(auth(token))
      .expect(200);
    return (res.body.data as { id: string }[]).map((i) => i.id);
  };

  const nodeIds = async (token: string, collectionId: string) => {
    const res = await request(app.getHttpServer())
      .get(`/v1/collections/${collectionId}/nodes`)
      .set(auth(token))
      .expect(200);
    return (res.body.data as { id: string }[]).map((n) => n.id);
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

  describe('possedes seuls', () => {
    it('ne montre que les possedes, et rend un 404 - pas un 403 - sur le reste', async () => {
      const d = await setup(['OWNED']);
      try {
        expect(await itemIds(d.member.token, d.collectionId)).toEqual([
          d.owned1,
        ]);

        // Un id hors statuts doit etre indistinguable d'un id inexistant : sinon un membre
        // deduit l'existence d'une wishlist en balayant des ids.
        await request(app.getHttpServer())
          .get(`/v1/items/${d.wish2}`)
          .set(auth(d.member.token))
          .expect(404);
        await request(app.getHttpServer())
          .get(`/v1/items/${d.ignored1}`)
          .set(auth(d.member.token))
          .expect(404);
        await request(app.getHttpServer())
          .get(`/v1/items/${d.wish2}/sources`)
          .set(auth(d.member.token))
          .expect(404);

        // Un noeud n'existe que par ses tomes retenus : la serie desiree sans tome disparait.
        expect(await nodeIds(d.member.token, d.collectionId)).toEqual([
          d.serieA,
        ]);
        await request(app.getHttpServer())
          .get(`/v1/nodes/${d.serieC}`)
          .set(auth(d.member.token))
          .expect(404);
      } finally {
        await teardown(d);
      }
    });

    it('recalcule itemCount et la hierarchie sous les statuts exposes', async () => {
      const d = await setup(['OWNED']);
      try {
        const res = await request(app.getHttpServer())
          .get(`/v1/collections/${d.collectionId}`)
          .set(auth(d.member.token))
          .expect(200);
        // La collection en compte 3 ; le membre en voit 1. C'est 1 qui doit sortir.
        expect(res.body.itemCount).toBe(1);
        // 3 series existent, 1 seule a un tome possede.
        expect(res.body.hierarchy).toEqual([
          { key: 'serie', label: 'Série', count: 1 },
        ]);

        // Meme chose dans la liste des partages recus : le resume ne doit pas mentir non plus.
        const received = await request(app.getHttpServer())
          .get('/v1/shares/received')
          .set(auth(d.member.token))
          .expect(200);
        expect(received.body).toHaveLength(1);
        expect(received.body[0].collections[0].itemCount).toBe(1);
      } finally {
        await teardown(d);
      }
    });

    it('masque le prix d achat et la note libre du proprietaire', async () => {
      const d = await setup(['OWNED']);
      try {
        const mine = await request(app.getHttpServer())
          .get(`/v1/items/${d.owned1}`)
          .set(auth(d.owner.token))
          .expect(200);
        expect(mine.body.userData).toMatchObject({
          purchasePrice: 12.5,
          note: 'offert par mamie',
        });

        const theirs = await request(app.getHttpServer())
          .get(`/v1/items/${d.owned1}`)
          .set(auth(d.member.token))
          .expect(200);
        expect(theirs.body.userData).toEqual({ status: 'OWNED', rating: 4 });
        expect(theirs.body.userData.purchasePrice).toBeUndefined();
        expect(theirs.body.userData.note).toBeUndefined();
        // Le reste du DTO est identique : l'app reutilise ses ecrans tels quels.
        expect(theirs.body.unifiedData).toEqual(mine.body.unifiedData);
      } finally {
        await teardown(d);
      }
    });
  });

  describe('desires seuls', () => {
    it('ne montre que les desires, series desirees sans tome comprises', async () => {
      const d = await setup(['WISHLIST']);
      try {
        expect(await itemIds(d.member.token, d.collectionId)).toEqual([
          d.wish2,
        ]);
        await request(app.getHttpServer())
          .get(`/v1/items/${d.owned1}`)
          .set(auth(d.member.token))
          .expect(404);

        // Serie A (elle a un tome desire) ET serie C (desiree, sans aucun tome).
        const nodes = await nodeIds(d.member.token, d.collectionId);
        expect(nodes.sort()).toEqual([d.serieA, d.serieC].sort());

        const serieA = await request(app.getHttpServer())
          .get(`/v1/nodes/${d.serieA}`)
          .set(auth(d.member.token))
          .expect(200);
        // ownedCount compte les tomes VISIBLES : 1 desire, pas les 2 de la serie.
        expect(serieA.body.ownedCount).toBe(1);
      } finally {
        await teardown(d);
      }
    });

    it('rend une liste vide quand rien n est desire, sans tout laisser passer', async () => {
      const d = await setup(['WISHLIST']);
      try {
        // On repasse le seul tome desire en possede : le partage n'a plus rien a montrer.
        await request(app.getHttpServer())
          .patch(`/v1/items/${d.wish2}`)
          .set(auth(d.owner.token))
          .send({ userData: { status: 'OWNED' } })
          .expect(200);

        expect(await itemIds(d.member.token, d.collectionId)).toEqual([]);
        const res = await request(app.getHttpServer())
          .get(`/v1/collections/${d.collectionId}`)
          .set(auth(d.member.token))
          .expect(200);
        expect(res.body.itemCount).toBe(0);
      } finally {
        await teardown(d);
      }
    });
  });

  describe('tous les statuts', () => {
    it('montre tout, y compris les ignores', async () => {
      const d = await setup(ALL_SHARE_STATUSES);
      try {
        const ids = await itemIds(d.member.token, d.collectionId);
        expect(ids.sort()).toEqual([d.owned1, d.wish2, d.ignored1].sort());
        expect(await nodeIds(d.member.token, d.collectionId)).toHaveLength(3);

        const res = await request(app.getHttpServer())
          .get(`/v1/collections/${d.collectionId}`)
          .set(auth(d.member.token))
          .expect(200);
        expect(res.body.itemCount).toBe(3);
      } finally {
        await teardown(d);
      }
    });

    // Le pendant de la regression attrapee cote proprietaire : la visibilite d'un noeud est
    // decidee a deux endroits (le `where` des listes, le predicat des lectures unitaires) et les
    // deux doivent dire la meme chose, y compris pour une serie encore vide.
    it('montre une serie vide non desiree, comme la liste', async () => {
      const d = await setup(ALL_SHARE_STATUSES);
      try {
        const vide = await request(app.getHttpServer())
          .post(`/v1/collections/${d.collectionId}/nodes`)
          .set(auth(d.owner.token))
          .send({
            level: 'serie',
            source: { provider: 'mal', externalId: '4' },
            isWishlist: false,
          })
          .expect(201);

        expect(await nodeIds(d.member.token, d.collectionId)).toContain(
          vide.body.id,
        );
        const detail = await request(app.getHttpServer())
          .get(`/v1/nodes/${vide.body.id}`)
          .set(auth(d.member.token))
          .expect(200);
        expect(detail.body.ownedCount).toBe(0);
      } finally {
        await teardown(d);
      }
    });

    it('masque quand meme le userData prive : le role decide, pas les statuts', async () => {
      const d = await setup(ALL_SHARE_STATUSES);
      try {
        const res = await request(app.getHttpServer())
          .get(`/v1/items/${d.owned1}`)
          .set(auth(d.member.token))
          .expect(200);
        expect(res.body.userData.purchasePrice).toBeUndefined();
        expect(res.body.userData.note).toBeUndefined();
      } finally {
        await teardown(d);
      }
    });
  });

  describe('lecture seule', () => {
    it('403 sur toute ecriture visant la collection partagee', async () => {
      const d = await setup(ALL_SHARE_STATUSES);
      try {
        const writes: (() => request.Test)[] = [
          () =>
            request(app.getHttpServer())
              .patch(`/v1/collections/${d.collectionId}`)
              .send({ name: 'renommee par le membre' }),
          () =>
            request(app.getHttpServer()).delete(
              `/v1/collections/${d.collectionId}`,
            ),
          () =>
            request(app.getHttpServer())
              .post(`/v1/collections/${d.collectionId}/items`)
              .send({
                node: { provider: 'mal', externalId: '1' },
                volume: 9,
                unifiedData: { title: 'intrus' },
              }),
          () =>
            request(app.getHttpServer())
              .post(`/v1/collections/${d.collectionId}/nodes`)
              .send({
                level: 'serie',
                source: { provider: 'mal', externalId: '9' },
              }),
          () =>
            request(app.getHttpServer())
              .patch(`/v1/items/${d.owned1}`)
              .send({ userData: { status: 'IGNORED' } }),
          () => request(app.getHttpServer()).delete(`/v1/items/${d.owned1}`),
          () =>
            request(app.getHttpServer())
              .post(`/v1/items/${d.owned1}/sources`)
              .send({ provider: 'isbn', externalId: '978' }),
          () =>
            request(app.getHttpServer())
              .patch(`/v1/nodes/${d.serieA}`)
              .send({ note: 10 }),
          () =>
            request(app.getHttpServer())
              .post(`/v1/nodes/${d.serieA}/sources`)
              .send({ provider: 'isbn', externalId: '978' }),
        ];
        for (const call of writes) {
          const res = await call().set(auth(d.member.token));
          expect(res.status).toBe(403);
        }

        // 403 veut dire refuse, pas refuse a moitie : rien n'a bouge.
        expect(
          await prisma.item.count({ where: { collectionId: d.collectionId } }),
        ).toBe(3);
        const coll = await prisma.collection.findUnique({
          where: { id: d.collectionId },
          select: { name: true },
        });
        expect(coll?.name).toBe('Mangas du salon');
      } finally {
        await teardown(d);
      }
    });

    it('les statuts ne se forcent pas depuis le client', async () => {
      const d = await setup(['OWNED']);
      try {
        // Aucun canal ne l'accepte : la query est validee en strict, le parametre est rejete.
        await request(app.getHttpServer())
          .get(`/v1/collections/${d.collectionId}/items?scope=all`)
          .set(auth(d.member.token))
          .expect(400);

        // Un en-tete invente ne change rien non plus : les statuts viennent de la base.
        const res = await request(app.getHttpServer())
          .get(`/v1/collections/${d.collectionId}/items`)
          .set(auth(d.member.token))
          .set('X-Share-Scope', 'all')
          .expect(200);
        expect((res.body.data as { id: string }[]).map((i) => i.id)).toEqual([
          d.owned1,
        ]);
      } finally {
        await teardown(d);
      }
    });
  });

  describe('fin d acces', () => {
    it('revoquer le partage coupe la lecture immediatement', async () => {
      const d = await setup(ALL_SHARE_STATUSES);
      try {
        await request(app.getHttpServer())
          .delete(`/v1/shares/${d.shareId}`)
          .set(auth(d.owner.token))
          .expect(204);

        await request(app.getHttpServer())
          .get(`/v1/collections/${d.collectionId}`)
          .set(auth(d.member.token))
          .expect(404);
        await request(app.getHttpServer())
          .get(`/v1/items/${d.owned1}`)
          .set(auth(d.member.token))
          .expect(404);
      } finally {
        await teardown(d);
      }
    });

    it('ejecter un membre coupe sa lecture', async () => {
      const d = await setup(ALL_SHARE_STATUSES);
      try {
        await request(app.getHttpServer())
          .delete(`/v1/shares/${d.shareId}/members/${d.member.userId}`)
          .set(auth(d.owner.token))
          .expect(204);

        await request(app.getHttpServer())
          .get(`/v1/collections/${d.collectionId}/items`)
          .set(auth(d.member.token))
          .expect(404);
      } finally {
        await teardown(d);
      }
    });

    it('le proprietaire qui perd son premium SUSPEND le partage (402), il ne le supprime pas', async () => {
      const d = await setup(ALL_SHARE_STATUSES);
      try {
        await prisma.premiumGrant.delete({ where: { userId: d.owner.userId } });

        await request(app.getHttpServer())
          .get(`/v1/collections/${d.collectionId}`)
          .set(auth(d.member.token))
          .expect(402);

        // Le partage et l'adhesion sont intacts : rendre le premium rend l'acces.
        await grantPremium(prisma, d.owner.userId);
        await request(app.getHttpServer())
          .get(`/v1/collections/${d.collectionId}`)
          .set(auth(d.member.token))
          .expect(200);
      } finally {
        await teardown(d);
      }
    });
  });

  describe('etancheite des deux cotes', () => {
    it('le proprietaire voit 100 % de sa collection, quels que soient les partages emis', async () => {
      const d = await setup(['WISHLIST']);
      try {
        expect((await itemIds(d.owner.token, d.collectionId)).sort()).toEqual(
          [d.owned1, d.wish2, d.ignored1].sort(),
        );
        expect(await nodeIds(d.owner.token, d.collectionId)).toHaveLength(3);
        const res = await request(app.getHttpServer())
          .get(`/v1/collections/${d.collectionId}`)
          .set(auth(d.owner.token))
          .expect(200);
        expect(res.body.itemCount).toBe(3);
        const item = await request(app.getHttpServer())
          .get(`/v1/items/${d.owned1}`)
          .set(auth(d.owner.token))
          .expect(200);
        expect(item.body.userData.purchasePrice).toBe(12.5);
      } finally {
        await teardown(d);
      }
    });

    it('une collection recue ne se melange pas a GET /v1/collections', async () => {
      const d = await setup(ALL_SHARE_STATUSES);
      try {
        // Le membre est gratuit : la liste de SES collections est un 402 (sync premium-only),
        // et surtout pas une liste contenant la collection d'autrui.
        await request(app.getHttpServer())
          .get('/v1/collections')
          .set(auth(d.member.token))
          .expect(402);

        await grantPremium(prisma, d.member.userId);
        const res = await request(app.getHttpServer())
          .get('/v1/collections')
          .set(auth(d.member.token))
          .expect(200);
        expect(res.body.data).toEqual([]);
      } finally {
        await teardown(d);
      }
    });

    it('un tiers qui n a rejoint aucun partage reste en 404', async () => {
      const d = await setup(ALL_SHARE_STATUSES);
      const outsider = await login(
        app,
        fakeGoogle,
        `e2e-s4-outsider-${randomBytes(6).toString('hex')}`,
      );
      try {
        await request(app.getHttpServer())
          .get(`/v1/collections/${d.collectionId}`)
          .set(auth(outsider.token))
          .expect(404);
        await request(app.getHttpServer())
          .get(`/v1/items/${d.owned1}`)
          .set(auth(outsider.token))
          .expect(404);
      } finally {
        await cleanupUser(prisma, outsider.userId);
        await teardown(d);
      }
    });
  });
});
