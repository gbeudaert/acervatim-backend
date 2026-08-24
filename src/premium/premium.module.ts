import { Global, Module } from '@nestjs/common';
import { CollectionAccessService } from './collection-access.service';
import { CollectionPremiumGuard } from './collection-premium.guard';
import { CollectionWriteGuard } from './collection-write.guard';
import { PremiumGuard } from './premium.guard';
import { PremiumService } from './premium.service';

@Global()
@Module({
  providers: [
    PremiumService,
    PremiumGuard,
    CollectionAccessService,
    CollectionPremiumGuard,
    CollectionWriteGuard,
  ],
  exports: [
    PremiumService,
    PremiumGuard,
    CollectionAccessService,
    CollectionPremiumGuard,
    CollectionWriteGuard,
  ],
})
export class PremiumModule {}
