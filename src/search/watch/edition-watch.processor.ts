import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EditionWatchService } from './edition-watch.service';
import {
  EDITION_WATCH_QUEUE,
  EditionWatchRunResult,
} from './edition-watch.types';

/**
 * Worker du rattrapage hebdomadaire. `concurrency: 1` par instance, et la file est bornée à 1 job
 * actif toutes instances confondues (`setGlobalConcurrency`, cf. {@link EditionWatchService}) : un
 * passage dure plusieurs minutes (une énumération BnF par édition, séquentielles) et deux passages
 * concurrents se marcheraient sur l'état des éditions.
 */
@Processor(EDITION_WATCH_QUEUE, { concurrency: 1 })
export class EditionWatchProcessor extends WorkerHost {
  constructor(private readonly watch: EditionWatchService) {
    super();
  }

  async process(_job: Job): Promise<EditionWatchRunResult> {
    // L'heure réelle et non l'échéance : la fenêtre part de la dernière vérification de chaque
    // édition (`sinceFor`), donc un passage en retard ne saute rien — il date juste ses détections.
    return this.watch.runOnce(new Date());
  }
}
