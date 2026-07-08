import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { GoogleBooksCoverService } from './googlebooks.service';
import { GoogleBooksProcessor } from './googlebooks.processor';
import { GoogleBooksResolver } from './googlebooks.resolver';
import { GBOOKS_QUEUE } from './googlebooks.types';

/**
 * Global (comme `BnfModule`) : `GoogleBooksCoverService` est injectable partout — notamment dans
 * `SearchService` pour enrichir l'énumération d'édition en jaquettes par ISBN.
 *
 * Découpage : `GoogleBooksCoverService` (producteur cache + enqueue), `GoogleBooksProcessor` (worker
 * BullMQ, seul à appeler Google Books, throttlé), `GoogleBooksResolver` (résolution réseau pure).
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: GBOOKS_QUEUE })],
  providers: [
    GoogleBooksCoverService,
    GoogleBooksProcessor,
    GoogleBooksResolver,
  ],
  exports: [GoogleBooksCoverService],
})
export class GoogleBooksModule {}
