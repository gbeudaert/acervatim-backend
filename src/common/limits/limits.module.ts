import { Global, Module } from '@nestjs/common';
import { LimitsService } from './limits.service';

@Global()
@Module({
  providers: [LimitsService],
  exports: [LimitsService],
})
export class LimitsModule {}
