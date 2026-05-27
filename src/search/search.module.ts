import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OauthModule } from '../oauth/oauth.module';
import { DiscogsAdapter } from '../oauth/providers/discogs.adapter';
import { MalAdapter } from '../oauth/providers/mal.adapter';
import { TmdbAdapter } from '../oauth/providers/tmdb.adapter';
import { SearchController } from './search.controller';
import { SearchService, SOURCE_ADAPTERS } from './search.service';

@Module({
  imports: [
    AuthModule /* JwtAuthGuard */,
    OauthModule /* expose les adapters */,
  ],
  controllers: [SearchController],
  providers: [
    SearchService,
    {
      provide: SOURCE_ADAPTERS,
      useFactory: (
        discogs: DiscogsAdapter,
        mal: MalAdapter,
        tmdb: TmdbAdapter,
      ) => [discogs, mal, tmdb],
      inject: [DiscogsAdapter, MalAdapter, TmdbAdapter],
    },
  ],
})
export class SearchModule {}
