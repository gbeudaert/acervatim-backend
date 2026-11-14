import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUserId } from '../../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminTokenGuard } from '../../invitations/admin-token.guard';
import { PremiumGuard } from '../../premium/premium.guard';
import { EditionWatchService } from './edition-watch.service';
import { SeriesUpdatesResponse } from './edition-watch.types';

/**
 * Rattrapage des séries en cours (SD3), côté lecture. Les gardes sont posées **par route** : la
 * route utilisateur exige un JWT puis le premium, la route admin un jeton admin — une garde de
 * classe JWT bloquerait l'appel admin, qui n'a pas de session.
 */
@ApiTags('series-updates')
@Controller()
export class SeriesUpdatesController {
  constructor(private readonly watch: EditionWatchService) {}

  /**
   * Tomes parus depuis l'import, par série de l'utilisateur, qu'il n'a pas encore. Réservé au
   * premium comme les routes de synchro : sans synchro, le serveur ne connaît ni ses séries ni ses
   * tomes. Lecture seule — l'app propose, l'utilisateur confirme, la synchro crée les items.
   */
  @Get('series-updates')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, PremiumGuard)
  async list(@CurrentUserId() userId: string): Promise<SeriesUpdatesResponse> {
    return this.watch.seriesUpdates(userId);
  }

  /** Déclenche un passage de rattrapage hors planification (test, rattrapage d'un incident). */
  @Post('admin/edition-watch/run')
  @HttpCode(202)
  @UseGuards(AdminTokenGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async run(): Promise<{ jobId: string }> {
    return this.watch.enqueueManualRun();
  }
}
