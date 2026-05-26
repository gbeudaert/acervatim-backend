import {
  ExecutionContext,
  createParamDecorator,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * Extrait `req.userId` posé par `JwtAuthGuard`.
 * À utiliser UNIQUEMENT sur des routes protégées par `@UseGuards(JwtAuthGuard)`.
 */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.userId) {
      throw new InternalServerErrorException(
        'CurrentUserId used without JwtAuthGuard',
      );
    }
    return req.userId;
  },
);
