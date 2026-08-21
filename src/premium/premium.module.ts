import { Global, Module } from '@nestjs/common';
import { CollectionAccessService } from './collection-access.service';
import { CollectionPremiumGuard } from './collection-premium.guard';
import { PremiumGuard } from './premium.guard';
import { PremiumService } from './premium.service';

@Global()
@Module({
  providers: [
    PremiumService,
    PremiumGuard,
    CollectionAccessService,
    CollectionPremiumGuard,
  ],
  exports: [
    PremiumService,
    PremiumGuard,
    CollectionAccessService,
    CollectionPremiumGuard,
  ],
})
export class PremiumModule {}
