import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Garde temporaire pour les endpoints admin.
 * Compare `Authorization: Bearer <token>` à ADMIN_API_TOKEN (env).
 * À remplacer par un vrai schéma d'auth admin (RBAC) quand dispo.
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(config: ConfigService) {
    const token = config.get<string>('ADMIN_API_TOKEN');
    if (!token || token.length < 16) {
      throw new Error('ADMIN_API_TOKEN must be set (≥ 16 chars)');
    }
    this.expected = Buffer.from(token, 'utf8');
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }
    const provided = Buffer.from(header.slice('Bearer '.length), 'utf8');
    if (provided.length !== this.expected.length || !timingSafeEqual(provided, this.expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}