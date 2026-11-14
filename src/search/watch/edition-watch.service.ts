import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { RedisHealthService } from '../../common/redis/redis-health.service';
import { PremiumService } from '../../premium/premium.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SearchService } from '../search.service';
import {
  dedupeEditions,
  EDITION_WATCH_CRON,
  EDITION_WATCH_QUEUE,
  EDITION_WATCH_RUN_JOB,
  EDITION_WATCH_SCHEDULER_ID,
  EditionWatchRunResult,
  EditionWatchState,
  editionWatchKey,
  mergeWatchState,
  missingTomes,
  NODE_PAGE_SIZE,
  readWatchableNode,
  SeriesUpdate,
  SeriesUpdatesResponse,
  nextSince,
  WatchableNode,
  WatchedEdition,
  WATCH_TTL_SECONDS,
} from './edition-watch.types';

/** Niveau des nœuds « série » (cf. `CollectionNode.level`). */
const SERIE_LEVEL = 'serie';
const MANGA_TYPE_CODE = 'manga';

/**
 * Rattrapage serveur des tomes parus après l'import (SD3).
 *
 * **Planification par BullMQ, pas par `@Cron`.** Un `@Cron` s'exécute dans chaque instance de
 * l'API : à deux instances, deux passages concurrents liraient et réécriraient le même état
 * d'édition, et doubleraient les requêtes BnF. Le planificateur BullMQ (`upsertJobScheduler`) ne
 * produit qu'un job par échéance, qu'un seul worker consomme, et `setGlobalConcurrency(1)` interdit
 * qu'un passage manuel chevauche le passage planifié — le verrou est celui de la passerelle déjà en
 * place (cf. scan-asynchrone-bullmq), sans verrou maison à écrire ni à expirer.
 *
 * Débit : les éditions sont traitées **séquentiellement** ; chaque énumération passe par la file
 * `bnf` en priorité background, derrière les scans interactifs.
 */
@Injectable()
export class EditionWatchService implements OnModuleInit {
  private readonly logger = new Logger(EditionWatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly premium: PremiumService,
    private readonly search: SearchService,
    private readonly cache: ApiCacheService,
    private readonly redisHealth: RedisHealthService,
    @InjectQueue(EDITION_WATCH_QUEUE) private readonly queue: Queue,
  ) {}

  onModuleInit(): void {
    // Les tests démarrent l'application sans vouloir de planification persistante dans Redis.
    if (process.env.NODE_ENV === 'test') return;
    // Non attendu : Redis indisponible au démarrage ne doit pas bloquer le boot de l'API (les
    // commandes BullMQ attendraient la reconnexion). Le planificateur sera posé au prochain boot.
    void this.ensureSchedule().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`edition-watch: planification impossible (${msg})`);
    });
  }

  /** Pose (ou met à jour) le planificateur hebdomadaire. Idempotent : même id à chaque boot. */
  async ensureSchedule(): Promise<void> {
    await this.queue.setGlobalConcurrency(1);
    await this.queue.upsertJobScheduler(
      EDITION_WATCH_SCHEDULER_ID,
      { pattern: EDITION_WATCH_CRON },
      {
        name: EDITION_WATCH_RUN_JOB,
        data: {},
        opts: {
          removeOnComplete: { count: 20 },
          removeOnFail: { count: 20 },
        },
      },
    );
    this.logger.log(
      `edition-watch: planifié (${EDITION_WATCH_CRON}, scheduler=${EDITION_WATCH_SCHEDULER_ID})`,
    );
  }

  /**
   * Déclenchement manuel (route admin) : enfile un passage, exécuté par le même worker que le
   * passage planifié — jamais en parallèle de lui (concurrence globale 1).
   */
  async enqueueManualRun(): Promise<{ jobId: string }> {
    if (!this.redisHealth.isAvailable()) {
      throw new ServiceUnavailableException(
        'edition-watch: file indisponible (Redis)',
      );
    }
    const job = await this.queue.add(
      EDITION_WATCH_RUN_JOB,
      {},
      {
        // BullMQ interdit `:` dans un jobId ; l'horodatage suffit à distinguer deux demandes.
        jobId: `manual-${Date.now()}`,
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 20 },
      },
    );
    return { jobId: String(job.id) };
  }

  /**
   * Éditions à interroger : nœuds manga dont le propriétaire est premium (seuls leurs nœuds sont
   * synchronisés et lisibles — la même règle que `CollectionPremiumGuard`, qui juge le statut du
   * propriétaire), non terminés, titre + éditeur connus ; dédupliquées par édition.
   */
  async selectWatchedEditions(): Promise<WatchedEdition[]> {
    const premiumByUser = new Map<string, boolean>();
    const watchable: WatchableNode[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await this.prisma.collectionNode.findMany({
        where: {
          level: SERIE_LEVEL,
          collection: { type: { code: MANGA_TYPE_CODE } },
        },
        select: { id: true, userId: true, unifiedData: true },
        orderBy: { id: 'asc' },
        take: NODE_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (page.length === 0) break;

      for (const node of page) {
        const w = readWatchableNode(node.unifiedData);
        if (!w) continue;
        let isPremium = premiumByUser.get(node.userId);
        if (isPremium === undefined) {
          isPremium = (await this.premium.getStatus(node.userId)).isPremium;
          premiumByUser.set(node.userId, isPremium);
        }
        if (isPremium) watchable.push(w);
      }

      if (page.length < NODE_PAGE_SIZE) break;
      cursor = page[page.length - 1].id;
    }

    return dedupeEditions(watchable);
  }

  /**
   * Un passage complet. Un échec sur une édition (BnF indisponible…) n'arrête pas les autres ; son
   * état n'est pas réécrit, donc sa fenêtre reprendra au même point la semaine suivante. Une
   * énumération incomplète, elle, est comptée à part (cf. {@link checkEdition}).
   */
  async runOnce(now: Date = new Date()): Promise<EditionWatchRunResult> {
    const editions = await this.selectWatchedEditions();
    let checked = 0;
    let failed = 0;
    let incomplete = 0;
    let newTomes = 0;

    for (const edition of editions) {
      try {
        const res = await this.checkEdition(edition, now);
        newTomes += res.added;
        if (!res.complete) incomplete++;
        checked++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `edition-watch: échec title="${edition.title}" publisher="${edition.publisherFr}" edition="${edition.edition ?? 'standard'}" (${msg})`,
        );
      }
    }

    this.logger.log(
      `edition-watch: passage terminé editions=${editions.length} checked=${checked} failed=${failed} incomplete=${incomplete} newTomes=${newTomes}`,
    );
    return {
      editions: editions.length,
      checked,
      failed,
      incomplete,
      newTomes,
    };
  }

  /**
   * Interroge une édition depuis sa dernière vérification et met son état à jour. Réutilise
   * l'énumération `since` d'`edition-mapping` (jaquettes servies en cache seulement) : la requête
   * SRU, ses filtres et l'identité d'édition restent écrits à un seul endroit.
   *
   * Énumération incomplète (troncature, page SRU en échec — absorbées par la BnF sans exception) :
   * les tomes trouvés sont gardés, mais `lastCheckedAt` n'avance pas et la même fenêtre sera
   * rejouée. Sans ça, deux passages ratés d'affilée dépasseraient la marge de recouvrement et des
   * tomes seraient perdus sans bruit.
   */
  async checkEdition(
    edition: WatchedEdition,
    now: Date,
  ): Promise<{ added: number; complete: boolean }> {
    const previous = await this.cache.get<EditionWatchState>(edition.key);
    const since = nextSince(previous, now);
    const mapping = await this.search.editionMapping(
      edition.title,
      edition.edition ?? undefined,
      undefined,
      edition.mangaId ?? undefined,
      { publisher: edition.publisherFr, since },
    );

    const { state, added } = mergeWatchState(
      previous,
      edition,
      mapping.tomes.map((t) => ({
        isbn: t.isbn,
        editionVolume: t.editionVolume,
        titleFr: t.titleFr,
        noticeCreatedAt: t.noticeCreatedAt,
        coverUrl: t.coverUrl,
      })),
      now,
      { since, complete: mapping.complete },
    );

    if (!mapping.complete) {
      this.logger.warn(
        `edition-watch: énumération incomplète title="${edition.title}" publisher="${edition.publisherFr}" ` +
          `edition="${edition.edition ?? 'standard'}" since=${since} tomesGardés=${added.length} ` +
          `-> lastCheckedAt inchangé (${state.lastCheckedAt ?? 'jamais'}), même fenêtre au prochain passage`,
      );
    }

    // Journal du délai de catalogage : date de création de la notice face à sa détection. Tant
    // qu'aucun passage complet n'a eu lieu, la fenêtre initiale de 60 jours ramène des notices
    // anciennes — leur écart ne mesure rien, d'où `initial=true` pour les écarter de l'analyse.
    const initial = !previous?.lastCheckedAt;
    for (const t of added) {
      this.logger.log(
        `edition-watch: new tome title="${edition.title}" vol=${t.editionVolume} isbn=${t.isbn ?? '-'} ` +
          `noticeCreatedAt=${t.noticeCreatedAt ?? '-'} detectedAt=${t.detectedAt}${initial ? ' initial=true' : ''}`,
      );
    }

    await this.cache.set(edition.key, state, WATCH_TTL_SECONDS);
    return { added: added.length, complete: mapping.complete };
  }

  /**
   * Séries de l'utilisateur auxquelles il manque des tomes détectés par le rattrapage. Lecture
   * seule : l'app propose, l'utilisateur confirme, et c'est la synchro qui crée les items.
   */
  async seriesUpdates(userId: string): Promise<SeriesUpdatesResponse> {
    const nodes = await this.prisma.collectionNode.findMany({
      where: {
        userId,
        level: SERIE_LEVEL,
        collection: { type: { code: MANGA_TYPE_CODE } },
      },
      select: { id: true, unifiedData: true },
    });
    const watchable = nodes
      .map((n) => ({ id: n.id, node: readWatchableNode(n.unifiedData) }))
      .filter((n): n is { id: string; node: WatchableNode } => n.node !== null);
    if (watchable.length === 0) return { updates: [] };

    const items = await this.prisma.item.findMany({
      where: {
        userId,
        nodeId: { in: watchable.map((n) => n.id) },
        volume: { not: null },
      },
      select: { nodeId: true, volume: true },
    });
    const volumesByNode = new Map<string, Set<number>>();
    for (const it of items) {
      if (it.nodeId === null || it.volume === null) continue;
      const set = volumesByNode.get(it.nodeId) ?? new Set<number>();
      set.add(it.volume);
      volumesByNode.set(it.nodeId, set);
    }

    const updates: SeriesUpdate[] = [];
    for (const { id, node } of watchable) {
      const state = await this.cache.get<EditionWatchState>(
        editionWatchKey(node.title, node.publisherFr, node.edition),
      );
      const newTomes = missingTomes(
        state,
        volumesByNode.get(id) ?? new Set<number>(),
      );
      if (newTomes.length === 0) continue;
      updates.push({
        nodeId: id,
        title: node.title,
        edition: node.edition,
        publisherFr: node.publisherFr,
        newTomes,
      });
    }
    return { updates };
  }
}
