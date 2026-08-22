import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PremiumGuard } from '../premium/premium.guard';
import { CreateShareDto } from './dto/create-share.dto';
import { RedeemShareDto } from './dto/redeem-share.dto';
import { SharingService } from './sharing.service';

/**
 * Gestion des partages : créer, lister, révoquer, rejoindre.
 *
 * **Aucune route de lecture de collection ici** : le partage n'ouvre pas de second chemin de
 * lecture, il étend l'autorisation des routes `collections`/`items`/`nodes` existantes — c'est le
 * travail de S4. Après S3, un membre a rejoint mais ne voit encore rien.
 *
 * Les deux racines (`collections/:id/shares` et `shares/...`) tiennent dans un seul contrôleur :
 * c'est une seule capacité, et les chemins complets sont déclarés route par route.
 */
@ApiTags('sharing')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class SharingController {
  constructor(private readonly sharing: SharingService) {}

  /**
   * Premium sur le **requérant** : émettre un partage suppose la sync cloud, donc le palier payant.
   * Le code en clair n'est renvoyé qu'ici, jamais re-récupérable (seul son HMAC est stocké).
   */
  @Post('collections/:id/shares')
  @UseGuards(PremiumGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) collectionId: string,
    @Body() dto: CreateShareDto,
  ) {
    return this.sharing.create(userId, collectionId, dto);
  }

  @Get('collections/:id/shares')
  async list(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) collectionId: string,
  ) {
    return this.sharing.list(userId, collectionId);
  }

  @Delete('shares/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) shareId: string,
  ): Promise<void> {
    await this.sharing.revoke(userId, shareId);
  }

  @Delete('shares/:id/members/:memberUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeMember(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) shareId: string,
    @Param('memberUserId', new ParseUUIDPipe()) memberUserId: string,
  ): Promise<void> {
    await this.sharing.revokeMember(userId, shareId, memberUserId);
  }

  /**
   * Volontairement **hors gate premium** : un partage qu'un compte gratuit ne pourrait pas rejoindre
   * n'aurait aucun intérêt. C'est le propriétaire qui paie le stockage, pas le membre.
   *
   * Bucket resserré : le seul moyen de trouver un code est de le balayer, et 144 bits d'entropie
   * ne dispensent pas d'une deuxième défense.
   */
  @Post('shares/redeem')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async redeem(@CurrentUserId() userId: string, @Body() dto: RedeemShareDto) {
    return this.sharing.redeem(dto.code, userId);
  }

  @Get('shares/received')
  async received(@CurrentUserId() userId: string) {
    return this.sharing.listReceived(userId);
  }
}
