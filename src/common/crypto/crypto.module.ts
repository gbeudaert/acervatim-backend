import { Global, Module } from '@nestjs/common';
import { AesService } from './aes.service';
import { HashService } from './hash.service';

@Global()
@Module({
  providers: [AesService, HashService],
  exports: [AesService, HashService],
})
export class CryptoModule {}
