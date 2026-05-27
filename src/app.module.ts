import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CollectionsModule } from './collections/collections.module';
import { AuditLogModule } from './common/audit/audit-log.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { QuotaModule } from './common/quota/quota.module';
import { validateEnv } from './config/env.validation';
import { InvitationsModule } from './invitations/invitations.module';
import { ItemsModule } from './items/items.module';
import { PrismaModule } from './prisma/prisma.module';
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
    CryptoModule,
    PrismaModule,
    QuotaModule,
    AuditLogModule,
    AuthModule,
    UsersModule,
    InvitationsModule,
    CollectionsModule,
    ItemsModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
