import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CollectionsModule } from './collections/collections.module';
import { AuditLogModule } from './common/audit/audit-log.module';
import { CryptoModule } from './common/crypto/crypto.module';
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
    CryptoModule,
    PrismaModule,
    AuditLogModule,
    AuthModule,
    UsersModule,
    InvitationsModule,
    CollectionsModule,
    ItemsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
