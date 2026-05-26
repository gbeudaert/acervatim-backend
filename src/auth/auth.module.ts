import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { IdentityResolverService } from './identity-resolver.service';
import { GoogleIdentityProvider } from './providers/google.provider';
import { IDENTITY_PROVIDERS } from './providers/identity-provider.interface';
import { IdentityProviderRegistry } from './providers/identity-provider.registry';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    IdentityResolverService,
    IdentityProviderRegistry,
    JwtAuthGuard,
    GoogleIdentityProvider,
    // Multi-provider DI : on injecte la LISTE des providers via le token IDENTITY_PROVIDERS.
    // Ajouter Apple = ajouter `AppleIdentityProvider` ici dans le factory + dans `providers`.
    {
      provide: IDENTITY_PROVIDERS,
      useFactory: (google: GoogleIdentityProvider) => [google],
      inject: [GoogleIdentityProvider],
    },
  ],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
