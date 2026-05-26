import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from '../../auth/auth.service';

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

/**
 * Lit `Authorization: Bearer <jwt>`, vérifie via `AuthService`, pose `req.userId`.
 * Opt-in : à appliquer par module via `@UseGuards(JwtAuthGuard)`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Empty bearer token');
    }
    const { userId } = this.authService.verifyJwt(token);
    req.userId = userId;
    return true;
  }
}
