import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { GoogleLoginDto } from './dto/google-login.dto';

/**
 * Endpoints d'échange credential-externe → JWT interne.
 *
 * Un endpoint par provider, chacun avec son propre DTO Zod (le shape du credential
 * varie selon le provider : `idToken` pour Google, `identityToken`+nonce pour Apple, …).
 * Ajouter un provider = ajouter (DTO + méthode 3 lignes) ici, plus son `IdentityProvider`.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('google')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { ttl: 60_000, limit: 10 } })
  async loginWithGoogle(@Body() dto: GoogleLoginDto) {
    return this.authService.loginWithProvider('google', dto);
  }
}
