import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SourcesModule } from '../common/sources/sources.module';
import { EditionImportController } from './import/edition-import.controller';
import { EditionImportProcessor } from './import/edition-import.processor';
import { EditionImportService } from './import/edition-import.service';
import { EDITION_IMPORT_QUEUE } from './import/edition-import.types';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [
    AuthModule /* JwtAuthGuard */,
    SourcesModule /* SOURCE_ADAPTERS */,
    BullModule.registerQueue({ name: EDITION_IMPORT_QUEUE }),
  ],
  controllers: [SearchController, EditionImportController],
  providers: [SearchService, EditionImportService, EditionImportProcessor],
})
export class SearchModule {}
