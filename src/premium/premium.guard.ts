import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request } from 'express';
import { PaymentRequiredException } from './payment-required.exception';
import { PremiumService } from './premium.service';

/**
 * À empiler APRÈS `JwtAuthGuard` : lit `req.userId` posé par celui-ci.
 * 402 si l'utilisateur n'est pas premium.
 */
@Injectable()
export class PremiumGuard implements CanActivate {
  constructor(private readonly premium: PremiumService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.userId) {
      throw new InternalServerErrorException(
        'PremiumGuard used without JwtAuthGuard',
      );
    }
    const { isPremium } = await this.premium.getStatus(req.userId);
    if (!isPremium) {
      throw new PaymentRequiredException();
    }
    return true;
  }
}
