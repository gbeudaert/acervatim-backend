import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { VerifyPurchaseDto } from './dto/verify-purchase.dto';
import { PubsubVerifierService } from './pubsub-verifier.service';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('subscriptions')
@Controller()
export class SubscriptionsController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly pubsubVerifier: PubsubVerifierService,
  ) {}

  @Post('subscriptions/verify')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async verify(
    @CurrentUserId() userId: string,
    @Body() dto: VerifyPurchaseDto,
  ) {
    return this.subscriptions.handleVerify(
      userId,
      dto.purchaseToken,
      dto.productId,
    );
  }

  /**
   * Webhook Pub/Sub RTDN — appelé par Google, pas par l'app.
   * Pas de JwtAuthGuard (Google ne possède pas notre JWT) ; auth via le JWT
   * OIDC signé par Google que `PubsubVerifierService` vérifie.
   * @SkipThrottle : les bursts RTDN ne doivent pas être limités côté throttler
   * applicatif — Pub/Sub retenterait en boucle (cf. sprint 06).
   */
  @Post('webhooks/google-play/rtdn')
  @SkipThrottle()
  @ApiExcludeEndpoint()
  @HttpCode(HttpStatus.OK)
  async rtdn(
    @Headers('authorization') authHeader: string | undefined,
    @Req() req: Request,
  ) {
    await this.pubsubVerifier.verify(authHeader);
    return this.subscriptions.handleRtdn(req.body);
  }
}
