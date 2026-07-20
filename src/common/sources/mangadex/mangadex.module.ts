import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { MangaDexCoverService } from './mangadex.service';
import { MangaDexProcessor } from './mangadex.processor';
import { MangaDexResolver } from './mangadex.resolver';
import { MANGADEX_QUEUE } from './mangadex.types';

/**
 * Global (comme `GoogleBooksModule`) : `MangaDexCoverService` est injectable partout — notamment
 * dans `SearchService` pour la cascade de jaquettes par tome (MangaDex par série+tome, prioritaire ;
 * Google Books par ISBN, en repli).
 *
 * Découpage : `MangaDexCoverService` (producteur cache + enqueue), `MangaDexProcessor` (worker
 * BullMQ throttlé, seul à appeler MangaDex), `MangaDexResolver` (résolution réseau pure).
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: MANGADEX_QUEUE })],
  providers: [MangaDexCoverService, MangaDexProcessor, MangaDexResolver],
  exports: [MangaDexCoverService],
})
export class MangaDexModule {}
