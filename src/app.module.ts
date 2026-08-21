import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
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
import { BnfModule } from './common/sources/bnf/bnf.module';
import { GoogleBooksModule } from './common/sources/googlebooks/googlebooks.module';
import { MangaDexModule } from './common/sources/mangadex/mangadex.module';
import { LimitsModule } from './common/limits/limits.module';
import { RedisHealthModule } from './common/redis/redis-health.module';
import { validateEnv } from './config/env.validation';
import { InvitationsModule } from './invitations/invitations.module';
import { ItemsModule } from './items/items.module';
import { QueueMetricsModule } from './metrics/queue-metrics.module';
import { NodesModule } from './nodes/nodes.module';
import { OauthModule } from './oauth/oauth.module';
import { PremiumModule } from './premium/premium.module';
import { PrismaModule } from './prisma/prisma.module';
import { SearchModule } from './search/search.module';
import { SourcesModule } from './sources/sources.module';
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
      // Un seul bucket global : 100 req/min/IP. Avec @nestjs/throttler v6, TOUT
      // throttler nommé ici s'applique à TOUTES les routes — un bucket « admin »
      // à 5/min bridait donc l'API entière (cf. fan-out des jaquettes manga).
      // Les routes sensibles resserrent ce bucket via @Throttle (auth 10, admin 5).
      throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }],
      // Désactivé en NODE_ENV=test : les e2e logent ~10x depuis 127.0.0.1
      // et exploseraient le bucket.
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    ScheduleModule.forRoot(),
    // BullMQ : backing Redis des files sortantes (throttle global + single-flight).
    // La connexion se reconnecte seule si Redis est indisponible au boot ; les
    // producteurs best-effort (jaquettes) dégradent en null plutôt que d'échouer.
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
        },
      }),
    }),
    CryptoModule,
    PrismaModule,
    HttpModule,
    ApiCacheModule,
    RedisHealthModule,
    BnfModule,
    GoogleBooksModule,
    MangaDexModule,
    LimitsModule,
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
    SourcesModule,
    SubscriptionsModule,
    QueueMetricsModule,
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
