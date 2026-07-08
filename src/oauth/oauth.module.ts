import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OAUTH_FLOW_PROVIDERS, OAuthFlowRegistry } from './oauth-flow.registry';
import { OauthController } from './oauth.controller';
import { OauthCredentialsService } from './oauth.service';
import { DiscogsAdapter } from './providers/discogs.adapter';
import { DiscogsProcessor } from './providers/discogs.processor';
import { DISCOGS_QUEUE } from './providers/discogs.types';
import { MalAdapter } from './providers/mal.adapter';
import { MalProcessor } from './providers/mal.processor';
import { MAL_QUEUE } from './providers/mal.types';
import { TmdbAdapter } from './providers/tmdb.adapter';
import { TmdbProcessor } from './providers/tmdb.processor';
import { TMDB_QUEUE } from './providers/tmdb.types';
import { TokenResolverService } from './token-resolver.service';

@Module({
  imports: [
    AuthModule, // pour JwtAuthGuard
    BullModule.registerQueue({ name: TMDB_QUEUE }),
    BullModule.registerQueue({ name: MAL_QUEUE }),
    BullModule.registerQueue({ name: DISCOGS_QUEUE }),
  ],
  controllers: [OauthController],
  providers: [
    OauthCredentialsService,
    TokenResolverService,
    DiscogsAdapter,
    DiscogsProcessor,
    MalAdapter,
    MalProcessor,
    TmdbAdapter,
    TmdbProcessor,
    OAuthFlowRegistry,
    {
      provide: OAUTH_FLOW_PROVIDERS,
      // TMDB n'a pas de flux user OAuth — il n'apparaît PAS ici (sa route /start renverra 404).
      useFactory: (discogs: DiscogsAdapter, mal: MalAdapter) => [discogs, mal],
      inject: [DiscogsAdapter, MalAdapter],
    },
  ],
  exports: [
    OauthCredentialsService,
    TokenResolverService,
    DiscogsAdapter,
    MalAdapter,
    TmdbAdapter,
  ],
})
export class OauthModule {}
