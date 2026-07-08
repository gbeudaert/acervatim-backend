import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BNF_QUEUE } from '../common/sources/bnf/bnf.types';
import { GBOOKS_QUEUE } from '../common/sources/googlebooks/googlebooks.types';
import { AdminTokenGuard } from '../invitations/admin-token.guard';
import { DISCOGS_QUEUE } from '../oauth/providers/discogs.types';
import { MAL_QUEUE } from '../oauth/providers/mal.types';
import { TMDB_QUEUE } from '../oauth/providers/tmdb.types';
import { EDITION_IMPORT_QUEUE } from '../search/import/edition-import.types';
import { QueueMetricsController } from './queue-metrics.controller';
import { QueueMetricsService } from './queue-metrics.service';

/**
 * Observabilité transverse des files BullMQ : agrège les compteurs de **toutes** les files (d'où
 * l'enregistrement des 6 noms ici — chaque file reste par ailleurs enregistrée dans son module
 * feature). `RedisHealthService` est fourni globalement.
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: GBOOKS_QUEUE },
      { name: BNF_QUEUE },
      { name: MAL_QUEUE },
      { name: DISCOGS_QUEUE },
      { name: TMDB_QUEUE },
      { name: EDITION_IMPORT_QUEUE },
    ),
  ],
  controllers: [QueueMetricsController],
  providers: [QueueMetricsService, AdminTokenGuard],
})
export class QueueMetricsModule {}
