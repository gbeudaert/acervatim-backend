import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ApiCacheService } from '../../cache/api-cache.service';
import { GoogleBooksResolver } from './googlebooks.resolver';
import {
  CachedCover,
  CoverJobData,
  CoverResult,
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
 * Cache **uniquement sur 2xx** : si `fetchCover` renvoie (HTTP 2xx), on met en cache — y compris une
 * absence d'image (`url: null`, absence légitime, TTL court). Si `fetchCover` **jette** (réseau /
 * 4xx / 5xx après retries), le job échoue et **rien n'est mis en cache** → re-tenté au prochain scan.
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
    const res = await this.resolver.fetchCover(isbn, hint);

    await this.cache.set<CachedCover>(
      coverCacheKey(isbn),
      { url: res.coverUrl, description: res.description },
      res.coverUrl ? HIT_TTL_SECONDS : MISS_TTL_SECONDS,
    );

    return res;
  }
}
