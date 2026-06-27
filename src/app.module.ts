import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CollectionsModule } from './collections/collections.module';
import { AuditLogModule } from './common/audit/audit-log.module';
import { ApiCacheModule } from './common/cache/api-cache.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AccessLogMiddleware } from './common/logging/access-log.middleware';
import { HttpModule } from './common/http/http.module';
import { QuotaModule } from './common/quota/quota.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { validateEnv } from './config/env.validation';
import { InvitationsModule } from './invitations/invitations.module';
import { ItemsModule } from './items/items.module';
import { NodesModule } from './nodes/nodes.module';
import { OauthModule } from './oauth/oauth.module';
import { PremiumModule } from './premium/premium.module';
import { PrismaModule } from './prisma/prisma.module';
import { SearchModule } from './search/search.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'default', ttl: 60_000, limit: 100 },
        { name: 'auth', ttl: 60_000, limit: 10 },
        { name: 'admin', ttl: 60_000, limit: 5 },
      ],
      // Désactivé en NODE_ENV=test : les e2e logent ~10x depuis 127.0.0.1
      // et exploseraient le bucket auth.
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    ScheduleModule.forRoot(),
    CryptoModule,
    PrismaModule,
    HttpModule,
    ApiCacheModule,
    RateLimitModule,
    QuotaModule,
    AuditLogModule,
    AuthModule,
    PremiumModule,
    UsersModule,
    InvitationsModule,
    CollectionsModule,
    ItemsModule,
    NodesModule,
    OauthModule,
    SearchModule,
    SubscriptionsModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(AccessLogMiddleware)
      .exclude(
        { path: 'health', method: RequestMethod.ALL },
        { path: 'health/(.*)', method: RequestMethod.ALL },
      )
      .forRoutes('*');
  }
}
