import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ApiCacheService } from '../../cache/api-cache.service';
import { GoogleBooksResolver } from './googlebooks.resolver';
import {
  CachedCover,
  CoverJobData,
  CoverResult,
  FAIL_TTL_SECONDS,
  GBOOKS_QUEUE,
  HIT_TTL_SECONDS,
  MISS_TTL_SECONDS,
  coverCacheKey,
} from './googlebooks.types';

/**
 * Seul point du code qui parle réellement à Google Books. Le **limiter** (débit sortant borné,
 * tous users confondus) et la **concurrence** remplacent l'ancien bucket `gbooks:global` (ligne SQL
 * à CAS optimiste qui livelockait sous rafale).
 *
 * **Cadence révisée à la baisse** (`concurrency: 1`, `limiter` 4 req/s) après récidive des 429/503
 * Google le 2026-07-08 : l'énumération d'une édition (~31 tomes) enfilait autant de jobs quasi
 * simultanés, et le limiter ne borne QUE le démarrage des jobs — chaque job fait jusqu'à 2 appels
 * (`isbn:` puis repli `intitle:`) et le `HttpClientService` retente 3× (503 → 3 requêtes), ce qui
 * amplifie l'engorgement. `concurrency: 1` sérialise donc les appels entre tomes ; `max: 4` laisse
 * une marge confortable vs. le seuil observé (l'ancien 10 req/s le déclenchait encore).
 *
 * Cache sur 2xx : si `fetchCover` renvoie (HTTP 2xx), on met en cache — jaquette (`HIT_TTL`) ou
 * absence d'image légitime (`url: null`, `MISS_TTL`). Si `fetchCover` **jette** (réseau / 4xx / 5xx
 * après retries), on pose un **cache négatif court** (`FAIL_TTL`) puis on **re-jette** : le job
 * échoue toujours (le backoff BullMQ retente en arrière-plan et écrase l'entrée dès qu'une tentative
 * réussit), mais pendant ce temps un nouveau scan du même ISBN court-circuite sur le cache au lieu de
 * ré-enfiler dans la file throttlée (incident prod 0.6.2 : mêmes ISBN ré-enfilés à chaque scan).
 */
@Processor(GBOOKS_QUEUE, {
  concurrency: 1,
  limiter: { max: 4, duration: 1000 },
})
export class GoogleBooksProcessor extends WorkerHost {
  constructor(
    private readonly resolver: GoogleBooksResolver,
    private readonly cache: ApiCacheService,
  ) {
    super();
  }

  async process(job: Job<CoverJobData, CoverResult>): Promise<CoverResult> {
    const { isbn, hint } = job.data;
    const key = coverCacheKey(isbn);

    let res: CoverResult;
    try {
      res = await this.resolver.fetchCover(isbn, hint);
    } catch (err) {
      // Échec dur (réseau / 4xx / 5xx après retries) → `unresolved` : cache négatif court pour couper
      // le ré-enqueue par de nouveaux scans pendant la vague, puis on re-jette (retry BullMQ en fond).
      await this.cache.set<CachedCover>(
        key,
        { url: null, description: null, status: 'unresolved' },
        FAIL_TTL_SECONDS,
      );
      throw err;
    }

    // 2xx : `found` (jaquette, TTL long) ou `absent` (Google confirme l'absence, TTL court).
    await this.cache.set<CachedCover>(
      key,
      { url: res.coverUrl, description: res.description, status: res.status },
      res.status === 'found' ? HIT_TTL_SECONDS : MISS_TTL_SECONDS,
    );

    return res;
  }
}
