import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PubsubVerifierService } from './pubsub-verifier.service';

function makeService(env: Record<string, string | undefined>) {
  const config = {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;
  const svc = new PubsubVerifierService(config);
  svc.onModuleInit();
  return svc;
}

describe('PubsubVerifierService — fail-secure', () => {
  it("refuse tous les pushs quand GOOGLE_PUBSUB_SA_EMAIL n'est pas configuré", async () => {
    const svc = makeService({
      GOOGLE_PUBSUB_SA_EMAIL: undefined,
      GOOGLE_PUBSUB_AUDIENCE: 'https://api.example/rtdn',
    });
    await expect(svc.verify('Bearer something')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("refuse tous les pushs quand GOOGLE_PUBSUB_AUDIENCE n'est pas configurée", async () => {
    const svc = makeService({
      GOOGLE_PUBSUB_SA_EMAIL: 'pubsub@x.iam.gserviceaccount.com',
      GOOGLE_PUBSUB_AUDIENCE: undefined,
    });
    await expect(svc.verify('Bearer something')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('PubsubVerifierService — bearer header parsing', () => {
  const svc = makeService({
    GOOGLE_PUBSUB_SA_EMAIL: 'pubsub@x.iam.gserviceaccount.com',
    GOOGLE_PUBSUB_AUDIENCE: 'https://api.example/rtdn',
  });

  it('throw quand le header est absent', async () => {
    await expect(svc.verify(undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throw quand le header ne commence pas par Bearer', async () => {
    await expect(svc.verify('Basic abc')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throw quand le JWT est invalide (OAuth2Client.verifyIdToken rejette)', async () => {
    // Pas de token forgé valide ici — verifyIdToken va catch et throw.
    await expect(svc.verify('Bearer not-a-valid-jwt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
