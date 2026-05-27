import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GooglePlayService } from './google-play.service';
import { PubsubVerifierService } from './pubsub-verifier.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  imports: [AuthModule], // pour JwtAuthGuard sur /subscriptions/verify
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, GooglePlayService, PubsubVerifierService],
  exports: [SubscriptionsService, GooglePlayService],
})
export class SubscriptionsModule {}
