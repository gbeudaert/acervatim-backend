import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { AuditLogService } from '../common/audit/audit-log.service';
import { IdentityResolverService } from './identity-resolver.service';
import { IdentityProviderRegistry } from './providers/identity-provider.registry';

export interface LoginResult {
  accessToken: string;
  userId: string;
}

/** Charges utiles minimales d'un JWT interne. */
interface JwtPayload {
  sub: string; // userId interne (UUID v4)
}

const JWT_ALGORITHM: jwt.Algorithm = 'RS256';
const JWT_EXPIRES_IN = '7d';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private privateKey!: string;
  private publicKey!: string;

  constructor(
    private readonly config: ConfigService,
    private readonly providers: IdentityProviderRegistry,
    private readonly identityResolver: IdentityResolverService,
    private readonly auditLog: AuditLogService,
  ) {}

  onModuleInit() {
    const priv = this.config.get<string>('JWT_PRIVATE_KEY');
    const pub = this.config.get<string>('JWT_PUBLIC_KEY');
    if (!priv || !pub) {
      throw new Error('JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must be set');
    }
    // .env stocke les clés avec des \n littéraux → on rétablit les vrais sauts de ligne.
    this.privateKey = priv.replace(/\\n/g, '\n');
    this.publicKey = pub.replace(/\\n/g, '\n');
  }

  /**
   * Échange un credential externe (id_token Google, etc.) contre un JWT interne.
   * Provider-agnostique : le routage se fait via `IdentityProviderRegistry`.
   */
  async loginWithProvider(
    providerName: string,
    credential: unknown,
  ): Promise<LoginResult> {
    const provider = this.providers.get(providerName);
    const { subject } = await provider.verify(credential);
    const { userId, isNew } = await this.identityResolver.resolveOrCreate(
      provider.name,
      subject,
    );

    const accessToken = this.signJwt({ sub: userId });

    this.logger.log(
      `auth.login provider=${provider.name} user=${userId.slice(0, 8)}… new=${isNew}`,
    );
    await this.auditLog.record({
      userId,
      action: 'auth.login',
      metadata: { provider: provider.name, isNew },
    });

    return { accessToken, userId };
  }

  /** Vérifie un JWT interne. Retourne `{ userId }` ou throw `UnauthorizedException`. */
  verifyJwt(token: string): { userId: string } {
    let decoded: jwt.JwtPayload | string;
    try {
      decoded = jwt.verify(token, this.publicKey, {
        algorithms: [JWT_ALGORITHM],
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
      throw new UnauthorizedException('Invalid token payload');
    }
    return { userId: decoded.sub };
  }

  private signJwt(payload: JwtPayload): string {
    return jwt.sign(payload, this.privateKey, {
      algorithm: JWT_ALGORITHM,
      expiresIn: JWT_EXPIRES_IN,
    });
  }
}
