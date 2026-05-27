import { Global, Module } from '@nestjs/common';
import { PremiumGuard } from './premium.guard';
import { PremiumService } from './premium.service';

@Global()
@Module({
  providers: [PremiumService, PremiumGuard],
  exports: [PremiumService, PremiumGuard],
})
export class PremiumModule {}
