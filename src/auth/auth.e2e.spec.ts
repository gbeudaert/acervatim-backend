import { INestApplication, RequestMethod } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { AppModule } from '../app.module';
import { ProblemDetailsExceptionFilter } from '../common/filters/problem-details.filter';
import { CorrelationIdInterceptor } from '../common/interceptors/correlation-id.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleIdentityProvider } from './providers/google.provider';

class FakeGoogleProvider {
  readonly name = 'google';
  subject = '';
  verify(_credential: unknown) {
    return Promise.resolve({ subject: this.subject });
  }
}

describe('Auth (e2e) — Google login + JWT', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeGoogle: FakeGoogleProvider;
  const subject = `e2e-google-sub-${randomBytes(8).toString('hex')}`;
  let userId: string | undefined;

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
    fakeGoogle.subject = subject;
  });

  afterAll(async () => {
    if (userId) {
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.auditLog.deleteMany({ where: { userId } });
    }
    await app.close();
  });

  it('POST /v1/auth/google retourne accessToken + userId (UUID v4)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/google')
      .send({ idToken: 'fake-token' })
      .expect(200);

    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.userId).toMatch(/^[0-9a-f-]{36}$/);
    userId = res.body.userId;
  });

  it('POST /v1/auth/google avec le même sub est idempotent (même userId)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/google')
      .send({ idToken: 'fake-token-2' })
      .expect(200);

    expect(res.body.userId).toBe(userId);
  });

  it('inscrit une ligne `auth.login` en audit_logs', async () => {
    const logs = await prisma.auditLog.findMany({
      where: { userId, action: 'auth.login' },
    });
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0].metadata).toMatchObject({ provider: 'google' });
  });

  it('POST /v1/auth/google rejette un payload invalide (Zod → Problem Details 400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/google')
      .send({})
      .expect(400);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.type).toContain('/probs/validation-error');
  });

  it('JWT non fourni sur route protégée → 401 Problem Details', async () => {
    const res = await request(app.getHttpServer()).get('/v1/me').expect(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.type).toContain('/probs/unauthorized');
  });
});
