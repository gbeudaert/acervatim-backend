import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SourcesModule } from '../common/sources/sources.module';
import { AdminTokenGuard } from '../invitations/admin-token.guard';
import { EditionImportController } from './import/edition-import.controller';
import { EditionImportProcessor } from './import/edition-import.processor';
import { EditionImportService } from './import/edition-import.service';
import { EDITION_IMPORT_QUEUE } from './import/edition-import.types';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { EditionWatchProcessor } from './watch/edition-watch.processor';
import { EditionWatchService } from './watch/edition-watch.service';
import { EDITION_WATCH_QUEUE } from './watch/edition-watch.types';
import { SeriesUpdatesController } from './watch/series-updates.controller';

@Module({
  imports: [
    AuthModule /* JwtAuthGuard */,
    SourcesModule /* SOURCE_ADAPTERS */,
    BullModule.registerQueue(
      { name: EDITION_IMPORT_QUEUE },
      // Rattrapage hebdomadaire des séries en cours (SD3) : réutilise SearchService, d'où sa place ici.
      { name: EDITION_WATCH_QUEUE },
    ),
  ],
  controllers: [
    SearchController,
    EditionImportController,
    SeriesUpdatesController,
  ],
  providers: [
    SearchService,
    EditionImportService,
    EditionImportProcessor,
    EditionWatchService,
    EditionWatchProcessor,
    AdminTokenGuard,
  ],
})
export class SearchModule {}
