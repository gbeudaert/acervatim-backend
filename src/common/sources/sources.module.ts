import { Module } from '@nestjs/common';
import { OauthModule } from '../../oauth/oauth.module';
import { DiscogsAdapter } from '../../oauth/providers/discogs.adapter';
import { MalAdapter } from '../../oauth/providers/mal.adapter';
import { TmdbAdapter } from '../../oauth/providers/tmdb.adapter';
import {
  SOURCE_ADAPTERS,
  SourceSnapshotService,
} from './source-snapshot.service';

@Module({
  imports: [OauthModule /* expose les adapters */],
  providers: [
    SourceSnapshotService,
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
  exports: [SOURCE_ADAPTERS, SourceSnapshotService],
})
export class SourcesModule {}
