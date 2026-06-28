import { Global, Module } from '@nestjs/common';
import { BnfService } from './bnf.service';

/**
 * Global (comme HttpModule/ApiCacheModule) : `BnfService` est injectable partout,
 * notamment dans `MalAdapter` (pivot ISBN→MAL) sans réimport.
 */
@Global()
@Module({
  providers: [BnfService],
  exports: [BnfService],
})
export class BnfModule {}
