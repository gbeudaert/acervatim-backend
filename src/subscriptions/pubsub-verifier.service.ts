import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';

/**
 * Vérifie le JWT OIDC signé par Google que Pub/Sub joint à chaque push
 * (`Authorization: Bearer <jwt>`). Sans ça, n'importe qui peut nous envoyer un
 * payload RTDN forgé.
 *
 * Si `GOOGLE_PUBSUB_SA_EMAIL` ou `GOOGLE_PUBSUB_AUDIENCE` ne sont pas
 * configurés, le verifier refuse tous les pushs (échec sécurisé). En dev/test
 * il faut donc soit configurer les deux, soit injecter un fake — c'est ce que
 * font les tests unitaires.
 */
@Injectable()
export class PubsubVerifierService implements OnModuleInit {
  private readonly logger = new Logger(PubsubVerifierService.name);
  private readonly client = new OAuth2Client();
  private saEmail?: string;
  private audience?: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.saEmail = this.config.get<string>('GOOGLE_PUBSUB_SA_EMAIL');
    this.audience = this.config.get<string>('GOOGLE_PUBSUB_AUDIENCE');
    if (!this.saEmail || !this.audience) {
      this.logger.warn(
        'Pub/Sub OIDC not configured (GOOGLE_PUBSUB_SA_EMAIL / GOOGLE_PUBSUB_AUDIENCE) — RTDN pushes will be rejected',
      );
    }
  }

  async verify(authHeader: string | undefined): Promise<void> {
    if (!this.saEmail || !this.audience) {
      throw new UnauthorizedException('pub/sub verifier not configured');
    }
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing pub/sub bearer token');
    }
    const idToken = authHeader.slice('Bearer '.length).trim();
    let payload;
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.audience,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('invalid pub/sub bearer token');
    }
    if (!payload || payload.email !== this.saEmail) {
      throw new UnauthorizedException('unauthorized pub/sub issuer');
    }
    if (payload.email_verified === false) {
      throw new UnauthorizedException('pub/sub issuer email not verified');
    }
  }
}
