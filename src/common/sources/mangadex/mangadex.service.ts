import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents } from 'bullmq';
import { ApiCacheService } from '../../cache/api-cache.service';
import { BnfAuthor } from '../bnf/bnf.types';
import { RedisHealthService } from '../../redis/redis-health.service';
import {
  identityCacheKey,
  identityJobId,
  MANGADEX_COVERS_JOB,
  MANGADEX_IDENTIFY_JOB,
  MANGADEX_QUEUE,
  MangaDexIdentity,
  MangaDexIdentityCacheEntry,
  MangaDexJobData,
  MangaDexJobResult,
  MangaDexSeriesCovers,
  SeriesCoverLookup,
  seriesCacheKey,
  seriesJobId,
} from './mangadex.types';

// Plafond d'attente d'une résolution (best-effort) : la série se résout en 1-few appels rapides.
const WAIT_TIMEOUT_MS = 15_000;

const UNRESOLVED: MangaDexSeriesCovers = {
  mangaId: null,
  volumes: {},
  status: 'unresolved',
};

/**
 * **Producteur** des résolutions de couvertures MangaDex (par série). Pipeline aligné sur
 * {@link GoogleBooksCoverService} : cache (`ApiCache`) → sinon **enqueue** sur la file `mangadex`
 * (throttle sortant + single-flight par série via `jobId`) → attente du worker. Best-effort : ne
 * jette jamais (Redis down, échec réseau, timeout → `unresolved`), pour ne pas casser l'énumération.
 *
 * Unité = la SÉRIE (une série = un job = ~1-3 appels) et non le tome : l'énumération d'une édition de
 * 30 tomes ne déclenche qu'UN appel MangaDex, contre 30 appels Google Books par ISBN.
 */
@Injectable()
export class MangaDexCoverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MangaDexCoverService.name);
  private queueEvents!: QueueEvents;

  constructor(
    @InjectQueue(MANGADEX_QUEUE)
    private readonly queue: Queue<MangaDexJobData, MangaDexJobResult>,
    private readonly config: ConfigService,
    private readonly cache: ApiCacheService,
    private readonly redisHealth: RedisHealthService,
  ) {}

  onModuleInit(): void {
    this.queueEvents = new QueueEvents(MANGADEX_QUEUE, {
      connection: {
        host: this.config.get<string>('REDIS_HOST', 'localhost'),
        port: this.config.get<number>('REDIS_PORT', 6379),
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents?.close();
  }

  /**
   * Lecture **cache-only** (jamais de réseau ni de file) : couvertures déjà résolues pour la série,
   * `unresolved` si pas encore en cache. Utilisé par l'endpoint `edition-mapping` (réponse < 1 s) ;
   * le réchauffage réel passe par le worker d'import via {@link resolveSeriesCovers}.
   */
  async cachedSeriesCovers(
    title: string,
    lookup: SeriesCoverLookup,
  ): Promise<MangaDexSeriesCovers> {
    const hit = await this.cache.get<MangaDexSeriesCovers>(
      seriesCacheKey(lookup.malId, title),
    );
    return hit ?? UNRESOLVED;
  }

  /**
   * Résout (réseau, best-effort) et met en cache les couvertures de la série. Hit de cache →
   * immédiat. Sinon enfile un job `mangadex` (dédup par série) et attend son résultat. `lookup` porte
   * les indices d'identification (mangaId/malId/auteurs) transmis au résolveur.
   */
  async resolveSeriesCovers(
    title: string,
    lookup: SeriesCoverLookup,
  ): Promise<MangaDexSeriesCovers> {
    const key = seriesCacheKey(lookup.malId, title);
    const cached = await this.cache.get<MangaDexSeriesCovers>(key);
    if (cached) return cached;

    if (!this.redisHealth.isAvailable()) return UNRESOLVED;

    try {
      const job = await this.queue.add(
        MANGADEX_COVERS_JOB,
        {
          title,
          mangaId: lookup.mangaId ?? null,
          malId: lookup.malId ?? null,
          authors: lookup.authors ?? [],
        },
        {
          jobId: seriesJobId(lookup.malId, title),
          removeOnComplete: { age: 60, count: 500 },
          // MangaDex 5xx est rare mais possible ; petit backoff pour absorber une vague.
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnFail: true,
        },
      );
      return (await job.waitUntilFinished(
        this.queueEvents,
        WAIT_TIMEOUT_MS,
      )) as MangaDexSeriesCovers;
    } catch {
      this.logger.warn(
        `mangadex: resolve failed title="${title}" mal=${lookup.malId ?? '-'}`,
      );
      return UNRESOLVED;
    }
  }

  /**
   * **Identifie** un manga (chemin nominal du scan) : hit de cache → immédiat ; sinon enfile un job
   * `mangadex:identify` (dédup par requête) et attend le worker. Best-effort — ne jette jamais (Redis
   * down, échec réseau, timeout → `null`), l'appelant ({@link MalAdapter}) repliant alors sur MAL.
   *
   * `authors` (auteurs BnF) sert la désambiguïsation titre/auteur côté résolveur.
   */
  async identifySeries(
    query: string,
    authors: BnfAuthor[],
  ): Promise<MangaDexIdentity | null> {
    const key = identityCacheKey(query);
    const cached = await this.cache.get<MangaDexIdentityCacheEntry>(key);
    if (cached) return cached.identity;

    if (!this.redisHealth.isAvailable()) return null;

    try {
      const job = await this.queue.add(
        MANGADEX_IDENTIFY_JOB,
        { query, authors },
        {
          jobId: identityJobId(query),
          removeOnComplete: { age: 60, count: 500 },
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnFail: true,
        },
      );
      const res = (await job.waitUntilFinished(
        this.queueEvents,
        WAIT_TIMEOUT_MS,
      )) as MangaDexIdentityCacheEntry;
      return res?.identity ?? null;
    } catch {
      this.logger.warn(`mangadex: identify failed query="${query}"`);
      return null;
    }
  }
}
