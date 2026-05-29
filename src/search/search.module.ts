import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SourcesModule } from '../common/sources/sources.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [AuthModule /* JwtAuthGuard */, SourcesModule /* SOURCE_ADAPTERS */],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
