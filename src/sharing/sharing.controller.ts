import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PremiumGuard } from '../premium/premium.guard';
import { CreateShareDto } from './dto/create-share.dto';
import { ListSharesQueryDto } from './dto/list-shares.query';
import { RedeemShareDto } from './dto/redeem-share.dto';
import { UpdateShareLabelDto } from './dto/update-share-label.dto';
import { SharingService } from './sharing.service';

/**
 * Gestion des partages : créer, lister, renommer, révoquer, rejoindre.
 *
 * **Aucune route de lecture de collection ici** : le partage n'ouvre pas de second chemin de
 * lecture, il étend l'autorisation des routes `collections`/`items`/`nodes` existantes (S4).
 *
 * Un partage porte **N collections**, chacune avec son jeu de statuts, et n'appartient donc plus à
 * une collection : les routes sont ancrées sur `/shares`, la collection n'étant plus qu'un filtre
 * de liste (`GET /v1/shares?collectionId=`).
 */
@ApiTags('sharing')
@ApiBearerAuth()
@Controller('shares')
@UseGuards(JwtAuthGuard)
export class SharingController {
  constructor(private readonly sharing: SharingService) {}

  /**
   * Premium sur le **requérant** : émettre un partage suppose la sync cloud, donc le palier payant.
   * Le code en clair n'est renvoyé qu'ici, jamais re-récupérable (seul son HMAC est stocké).
   */
  @Post()
  @UseGuards(PremiumGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUserId() userId: string, @Body() dto: CreateShareDto) {
    return this.sharing.create(userId, dto);
  }

  /**
   * Volontairement **hors gate premium**, comme la révocation : un propriétaire dont le premium a
   * expiré doit pouvoir constater et retirer ce qu'il a partagé. Seule l'émission est payante.
   */
  @Get()
  async list(
    @CurrentUserId() userId: string,
    @Query() query: ListSharesQueryDto,
  ) {
    return this.sharing.list(userId, query.collectionId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) shareId: string,
  ): Promise<void> {
    await this.sharing.revoke(userId, shareId);
  }

  @Delete(':id/members/:memberUserId')
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
  @Post('redeem')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async redeem(@CurrentUserId() userId: string, @Body() dto: RedeemShareDto) {
    return this.sharing.redeem(dto.code, userId, dto.label ?? null);
  }

  @Get('received')
  async received(@CurrentUserId() userId: string) {
    return this.sharing.listReceived(userId);
  }

  /**
   * Libellé côté **membre**, distinct de celui du propriétaire : chacun nomme le partage pour soi,
   * et ne voit jamais le nom que l'autre lui donne.
   */
  @Patch('received/:shareId')
  async updateReceivedLabel(
    @CurrentUserId() userId: string,
    @Param('shareId', new ParseUUIDPipe()) shareId: string,
    @Body() dto: UpdateShareLabelDto,
  ) {
    return this.sharing.updateMembershipLabel(userId, shareId, dto.label);
  }

  /**
   * Déclaré APRÈS les routes `received/…` et `redeem` : Express résout dans l'ordre de déclaration,
   * et `:id` capterait sinon ces segments littéraux pour les refuser en 400.
   */
  @Patch(':id')
  async updateLabel(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) shareId: string,
    @Body() dto: UpdateShareLabelDto,
  ) {
    return this.sharing.updateLabel(userId, shareId, dto.label);
  }
}
