import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OAUTH_FLOW_PROVIDERS, OAuthFlowRegistry } from './oauth-flow.registry';
import { OauthController } from './oauth.controller';
import { OauthCredentialsService } from './oauth.service';
import { DiscogsAdapter } from './providers/discogs.adapter';
import { MalAdapter } from './providers/mal.adapter';
import { TmdbAdapter } from './providers/tmdb.adapter';
import { TokenResolverService } from './token-resolver.service';

@Module({
  imports: [AuthModule], // pour JwtAuthGuard
  controllers: [OauthController],
  providers: [
    OauthCredentialsService,
    TokenResolverService,
    DiscogsAdapter,
    MalAdapter,
    TmdbAdapter,
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
