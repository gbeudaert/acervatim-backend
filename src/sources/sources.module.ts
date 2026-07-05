import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OauthModule } from '../oauth/oauth.module';
import { SourcesController } from './sources.controller';

@Module({
  // AuthModule : JwtAuthGuard ; OauthModule : OauthCredentialsService (store/remove).
  imports: [AuthModule, OauthModule],
  controllers: [SourcesController],
})
export class SourcesModule {}
