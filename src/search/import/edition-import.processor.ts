import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { SearchService } from '../search.service';
import {
  EDITION_IMPORT_QUEUE,
  EditionImportJobData,
  EditionImportResult,
} from './edition-import.types';

/**
 * Worker d'import de série : énumère l'édition (BnF) puis résout la jaquette + le résumé de chaque
 * tome (via `SearchService.warmEditionMapping`, qui passe par la file `gbooks` throttlée). Son but
 * **est** de réchauffer le cache — l'endpoint HTTP `GET /v1/search/edition-mapping` reste cache-only
 * (< 1 s) : quand le job est `done`, l'app re-tape l'endpoint et récupère les jaquettes du cache.
 *
 * `concurrency: 1` : les imports sont sérialisés (tâche de fond), sans jamais affamer les scans
 * interactifs qui, eux, vivent sur leurs propres files. La progression est publiée via
 * `job.updateProgress` pour l'écran d'avancement.
 */
@Processor(EDITION_IMPORT_QUEUE, { concurrency: 1 })
export class EditionImportProcessor extends WorkerHost {
  constructor(private readonly search: SearchService) {
    super();
  }

  async process(
    job: Job<EditionImportJobData, EditionImportResult>,
  ): Promise<EditionImportResult> {
    const { title, edition, malId, mangaId } = job.data;

    // Phase 1 : énumération BnF (le total n'est connu qu'après). On l'annonce pour l'UI.
    await job.updateProgress({ phase: 'enumerating', done: 0, total: 0 });

    const mapping = await this.search.warmEditionMapping(
      title,
      edition ?? undefined,
      (done, total) => {
        // `updateProgress` est async ; on ne bloque pas la résolution dessus (best-effort UI).
        void job.updateProgress({ phase: 'covers', done, total });
      },
      malId ?? undefined,
      mangaId ?? undefined,
    );

    return { tomeCount: mapping.tomes.length };
  }
}
