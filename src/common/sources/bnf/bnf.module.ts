import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { BnfProcessor } from './bnf.processor';
import { BnfService } from './bnf.service';
import { BNF_QUEUE } from './bnf.types';

/**
 * Global (comme HttpModule/ApiCacheModule) : `BnfService` est injectable partout,
 * notamment dans `MalAdapter` (pivot ISBN→MAL) sans réimport.
 *
 * `BnfService` produit des jobs SRU sur la file `bnf` ; `BnfProcessor` (worker throttlé) est le seul
 * à interroger réellement la BnF.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: BNF_QUEUE })],
  providers: [BnfService, BnfProcessor],
  exports: [BnfService],
})
export class BnfModule {}
