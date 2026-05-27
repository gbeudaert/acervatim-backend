import { Global, Module } from '@nestjs/common';
import { TokenBucketService } from './token-bucket.service';

@Global()
@Module({
  providers: [TokenBucketService],
  exports: [TokenBucketService],
})
export class RateLimitModule {}
