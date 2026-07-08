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
 * à CAS optimiste qui livelockait sous rafale). `concurrency: 2` laisse deux résolutions de front ;
 * `limiter` lisse à 10 req/s pour ne pas déclencher les 429/503 Google observés sous ~60 appels
 * quasi simultanés (cf. incident 0.5.3).
 *
 * Cache **uniquement sur 2xx** : si `fetchCover` renvoie (HTTP 2xx), on met en cache — y compris une
 * absence d'image (`url: null`, absence légitime, TTL court). Si `fetchCover` **jette** (réseau /
 * 4xx / 5xx après retries), le job échoue et **rien n'est mis en cache** → re-tenté au prochain scan.
 */
@Processor(GBOOKS_QUEUE, {
  concurrency: 2,
  limiter: { max: 10, duration: 1000 },
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
