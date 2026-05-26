import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import {
  IdentityProvider,
  VerifiedIdentity,
} from './identity-provider.interface';

const GoogleCredentialSchema = z.object({
  idToken: z.string().min(1),
});

@Injectable()
export class GoogleIdentityProvider implements IdentityProvider, OnModuleInit {
  readonly name = 'google';

  private readonly logger = new Logger(GoogleIdentityProvider.name);
  private client!: OAuth2Client;
  private audience!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const audience = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!audience) {
      throw new Error('GOOGLE_CLIENT_ID must be set');
    }
    this.audience = audience;
    this.client = new OAuth2Client();
  }

  async verify(credential: unknown): Promise<VerifiedIdentity> {
    const parsed = GoogleCredentialSchema.safeParse(credential);
    if (!parsed.success) {
      throw new UnauthorizedException('Invalid Google credential payload');
    }

    let payload;
    try {
      const ticket = await this.client.verifyIdToken({
        idToken: parsed.data.idToken,
        audience: this.audience,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('Invalid Google id_token');
    }

    if (!payload?.sub) {
      throw new UnauthorizedException('Invalid Google id_token payload');
    }

    return { subject: payload.sub };
  }
}
