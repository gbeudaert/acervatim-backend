import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OauthCredentialsService } from '../oauth/oauth.service';
import { SetTmdbTokenDto } from './dto/set-tmdb-token.dto';

/**
 * Gestion des jetons de source qui ne passent pas par OAuth. TMDB n'a pas de flux
 * OAuth utilisateur : l'utilisateur saisit sa **clé API personnelle** (BYOT, Q-d),
 * stockée chiffrée dans `oauth_credentials` (provider `tmdb`) comme les autres.
 * L'adapter la privilégie via `TokenResolverService` (repli `TMDB_API_KEY` serveur
 * si premium).
 */
@ApiTags('sources')
@Controller('sources')
export class SourcesController {
  constructor(private readonly credentials: OauthCredentialsService) {}

  /** Enregistre/remplace la clé API TMDB personnelle. 204. */
  @Put('tmdb/token')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  async setTmdbToken(
    @CurrentUserId() userId: string,
    @Body() dto: SetTmdbTokenDto,
  ): Promise<void> {
    await this.credentials.store(userId, 'tmdb', {
      accessToken: dto.token,
      expiresAtMs: 0,
      scopes: [],
    });
  }

  /** Supprime la clé API TMDB personnelle. 204 (idempotent). */
  @Delete('tmdb/token')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeTmdbToken(@CurrentUserId() userId: string): Promise<void> {
    await this.credentials.remove(userId, 'tmdb');
  }
}
