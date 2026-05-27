import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OAuthFlowRegistry } from './oauth-flow.registry';
import { OauthCredentialsService } from './oauth.service';

@ApiTags('oauth')
@Controller('oauth')
export class OauthController {
  constructor(
    private readonly registry: OAuthFlowRegistry,
    private readonly credentials: OauthCredentialsService,
  ) {}

  /** Démarre le flux : renvoie l'URL d'autorisation à ouvrir côté app. */
  @Get(':provider/start')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async start(
    @CurrentUserId() userId: string,
    @Param('provider') provider: string,
  ): Promise<{ authorizeUrl: string }> {
    return this.registry.get(provider).start(userId);
  }

  /**
   * Callback Discogs/MAL — endpoint non authentifié.
   * L'identité du user est rétablie via le pending request token côté provider.
   */
  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query() query: Record<string, string>,
  ): Promise<{ status: 'connected'; provider: string }> {
    await this.registry.get(provider).callback(query);
    return { status: 'connected', provider };
  }

  /** Liste des providers connectés (jamais le token, même chiffré). */
  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async list(
    @CurrentUserId() userId: string,
  ): Promise<{ data: Array<{ provider: string; expiresAtMs: number }> }> {
    const data = await this.credentials.listConnected(userId);
    return { data };
  }

  /** Révoque les credentials pour ce provider chez ce user. 204. */
  @Delete(':provider')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUserId() userId: string,
    @Param('provider') provider: string,
  ): Promise<void> {
    // 404 si provider inconnu — la registry valide pour nous et narrow le type.
    const flow = this.registry.get(provider);
    await this.credentials.remove(userId, flow.provider);
  }
}
