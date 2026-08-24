import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Compteurs de hit/miss d'une **famille** de clés de cache (cf. {@link ApiCacheService.stats}).
 * `family` est déclarée par l'appelant, jamais dérivée de la clé complète : une clé porte la
 * requête utilisateur (`discogs:search:q:degiheugi:1:50`) et servirait un cardinal non borné.
 */
export interface CacheFamilyStat {
  family: string;
  hits: number;
  misses: number;
  /** `hits / (hits + misses)`, arrondi au centième. `0` tant qu'aucun accès n'a eu lieu. */
  hitRate: number;
}

/**
 * Garde-fou de cardinalité : au-delà, les nouvelles familles sont agrégées sous `other`. Le
 * nombre de familles réellement déclarées est d'un ordre de grandeur inférieur.
 */
const MAX_TRACKED_FAMILIES = 50;

@Injectable()
export class ApiCacheService {
  private readonly logger = new Logger(ApiCacheService.name);

  /**
   * Hit/miss par famille, en mémoire du processus (remis à zéro au redémarrage). Sert à
   * **mesurer** le taux de hit du cache partagé plutôt qu'à le supposer — en particulier
   * l'écart attendu entre `discogs:search:barcode` (clés très partagées entre utilisateurs)
   * et `discogs:search:q` (requêtes libres, donc peu partagées), qui détermine la pression
   * réelle sur le quota Discogs. Exposé par `GET /admin/queues`.
   */
  private readonly counters = new Map<string, { hits: number; misses: number }>(
    [],
  );

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hit → renvoie le payload caché. Miss/expired → exécute `fetcher`, persiste, renvoie.
   * Les erreurs du fetcher remontent telles quelles ; aucun négatif n'est mis en cache.
   *
   * `family` (optionnel) est l'étiquette de mesure : voir {@link stats}. Non renseignée, on
   * retombe sur le premier segment de la clé (le provider), qui est toujours de cardinal borné.
   */
  async getOrFetch<T>(
    key: string,
    ttlSeconds: number,
    fetcher: () => Promise<T>,
    family?: string,
  ): Promise<T> {
    const now = new Date();
    const hit = await this.prisma.apiCache.findUnique({
      where: { cacheKey: key },
    });
    if (hit && hit.expiresAt > now) {
      this.record(family ?? defaultFamily(key), true);
      return hit.payload as T;
    }
    this.record(family ?? defaultFamily(key), false);

    const fresh = await fetcher();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    await this.prisma.apiCache.upsert({
      where: { cacheKey: key },
      create: {
        cacheKey: key,
        payload: fresh as Prisma.InputJsonValue,
        fetchedAt: now,
        expiresAt,
      },
      update: {
        payload: fresh as Prisma.InputJsonValue,
        fetchedAt: now,
        expiresAt,
      },
    });

    return fresh;
  }

  /**
   * Récupère un payload non expiré, ou null. Pas de fetcher — c'est un get pur.
   * `family` : étiquette de mesure, cf. {@link getOrFetch}. Compte hit/miss comme `getOrFetch`,
   * ce qui inclut les lectures du **mode dégradé** (cache-only, sans jeton).
   */
  async get<T>(key: string, family?: string): Promise<T | null> {
    const row = await this.prisma.apiCache.findUnique({
      where: { cacheKey: key },
    });
    const fresh = Boolean(row && row.expiresAt > new Date());
    if (family !== undefined) this.record(family, fresh);
    if (!fresh) return null;
    return row!.payload as T;
  }

  /**
   * Instantané des compteurs hit/miss par famille, trié par volume décroissant. Lecture seule :
   * les compteurs ne sont jamais remis à zéro en cours de vie du processus, donc deux relevés
   * successifs se soustraient pour obtenir le taux sur l'intervalle.
   */
  stats(): CacheFamilyStat[] {
    return [...this.counters.entries()]
      .map(([family, c]) => {
        const total = c.hits + c.misses;
        return {
          family,
          hits: c.hits,
          misses: c.misses,
          hitRate: total === 0 ? 0 : Math.round((c.hits / total) * 100) / 100,
        };
      })
      .sort((a, b) => b.hits + b.misses - (a.hits + a.misses));
  }

  private record(family: string, hit: boolean): void {
    const key = this.counters.has(family)
      ? family
      : this.counters.size >= MAX_TRACKED_FAMILIES
        ? 'other'
        : family;
    const c = this.counters.get(key) ?? { hits: 0, misses: 0 };
    if (hit) c.hits++;
    else c.misses++;
    this.counters.set(key, c);
  }

  /** Upsert direct (pour stocker du contenu non lié à un fetch externe : pending OAuth, ...). */
  async set<T>(key: string, payload: T, ttlSeconds: number): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    await this.prisma.apiCache.upsert({
      where: { cacheKey: key },
      create: {
        cacheKey: key,
        payload: payload as Prisma.InputJsonValue,
        fetchedAt: now,
        expiresAt,
      },
      update: {
        payload: payload as Prisma.InputJsonValue,
        fetchedAt: now,
        expiresAt,
      },
    });
  }

  async delete(key: string): Promise<void> {
    await this.prisma.apiCache
      .delete({ where: { cacheKey: key } })
      .catch(() => undefined);
  }

  /**
   * Supprime les rows expirées. Appelé par un cron applicatif (sprint ultérieur).
   * Retourne le nombre de rows supprimées pour log.
   */
  async pruneExpired(): Promise<number> {
    const res = await this.prisma.apiCache.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (res.count > 0) {
      this.logger.log(`api-cache: pruned ${res.count} expired rows`);
    }
    return res.count;
  }
}

/**
 * Repli quand l'appelant ne déclare pas de famille : le premier segment de la clé, c'est-à-dire
 * le provider (`discogs`, `mal`, `gbooks`, ...). Toujours de cardinal borné, contrairement à la
 * clé complète qui porte la requête utilisateur.
 */
function defaultFamily(key: string): string {
  const idx = key.indexOf(':');
  return idx === -1 ? key : key.slice(0, idx);
}
