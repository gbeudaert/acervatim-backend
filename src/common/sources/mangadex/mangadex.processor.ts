import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ApiCacheService } from '../../cache/api-cache.service';
import { MangaDexResolver } from './mangadex.resolver';
import {
  FAIL_TTL_SECONDS,
  HIT_TTL_SECONDS,
  identityCacheKey,
  MANGADEX_IDENTIFY_JOB,
  MANGADEX_QUEUE,
  MISS_TTL_SECONDS,
  MangaDexCoversJobData,
  MangaDexIdentifyJobData,
  MangaDexIdentityCacheEntry,
  MangaDexJobData,
  MangaDexJobResult,
  MangaDexSeriesCovers,
  seriesCacheKey,
} from './mangadex.types';

/**
 * Seul point qui parle réellement à MangaDex. **Limiter** (débit sortant borné, tous users) +
 * **concurrence 1** : l'API MangaDex plafonne ~5 req/s ; on reste en dessous (une série = ~1-3
 * appels, sérialisés). Comme Google Books, on met en cache sur 2xx (jaquettes `HIT_TTL`, ou absence
 * légitime `MISS_TTL`) ; sur échec dur (réseau/5xx après retries) on pose un cache négatif court
 * (`FAIL_TTL`) puis on re-jette (le backoff BullMQ retente en fond et écrase l'entrée au succès).
 *
 * Deux jobs, discriminés par `job.name` : `series-covers` (jaquettes par tome) et `identify` (pivot
 * BnF→MangaDex). Ce dernier **réchauffe gratuitement** le cache de jaquettes de la série sous la clé
 * `mal` dès qu'un `malId` est trouvé → l'endpoint `edition-mapping` les sert en cache-only.
 */
@Processor(MANGADEX_QUEUE, {
  concurrency: 1,
  limiter: { max: 4, duration: 1000 },
})
export class MangaDexProcessor extends WorkerHost {
  constructor(
    private readonly resolver: MangaDexResolver,
    private readonly cache: ApiCacheService,
  ) {
    super();
  }

  async process(
    job: Job<MangaDexJobData, MangaDexJobResult>,
  ): Promise<MangaDexJobResult> {
    if (job.name === MANGADEX_IDENTIFY_JOB) {
      return this.processIdentify(job.data as MangaDexIdentifyJobData);
    }
    return this.processCovers(job.data as MangaDexCoversJobData);
  }

  /** Résout et cache les jaquettes d'une série (jaquettes `HIT_TTL`, absence `MISS_TTL`). */
  private async processCovers(
    data: MangaDexCoversJobData,
  ): Promise<MangaDexSeriesCovers> {
    const { title, malId } = data;
    const key = seriesCacheKey(malId, title);

    let res: MangaDexSeriesCovers;
    try {
      res = await this.resolver.fetchSeriesCovers(title, malId);
    } catch (err) {
      await this.cache.set<MangaDexSeriesCovers>(
        key,
        { mangaId: null, volumes: {}, status: 'unresolved' },
        FAIL_TTL_SECONDS,
      );
      throw err;
    }

    await this.cache.set<MangaDexSeriesCovers>(
      key,
      res,
      res.status === 'found' ? HIT_TTL_SECONDS : MISS_TTL_SECONDS,
    );
    return res;
  }

  /**
   * Identifie un manga et cache l'identité (trouvée `HIT_TTL`, `null` `MISS_TTL`). En cas de succès
   * avec `malId`, **réchauffe** aussi le cache de jaquettes de la série (clé `mal`) : l'énumération
   * d'édition les servira sans re-taper MangaDex.
   */
  private async processIdentify(
    data: MangaDexIdentifyJobData,
  ): Promise<MangaDexIdentityCacheEntry> {
    const { query, authors } = data;
    const key = identityCacheKey(query);

    let identity: MangaDexIdentityCacheEntry['identity'];
    try {
      identity = await this.resolver.identify(query, authors);
    } catch (err) {
      await this.cache.set<MangaDexIdentityCacheEntry>(
        key,
        { identity: null },
        FAIL_TTL_SECONDS,
      );
      throw err;
    }

    await this.cache.set<MangaDexIdentityCacheEntry>(
      key,
      { identity },
      identity ? HIT_TTL_SECONDS : MISS_TTL_SECONDS,
    );

    // Réchauffage gratuit du cache de jaquettes de la série (clé `mal`, indifférente au titre) :
    // l'endpoint `edition-mapping` (cachedSeriesCovers) le servira sans appel réseau.
    if (identity?.malId) {
      const volumeCount = Object.keys(identity.volumes).length;
      await this.cache.set<MangaDexSeriesCovers>(
        seriesCacheKey(identity.malId, identity.title),
        {
          mangaId: identity.mangaId,
          volumes: identity.volumes,
          status: volumeCount > 0 ? 'found' : 'absent',
        },
        volumeCount > 0 ? HIT_TTL_SECONDS : MISS_TTL_SECONDS,
      );
    }

    return { identity };
  }
}
