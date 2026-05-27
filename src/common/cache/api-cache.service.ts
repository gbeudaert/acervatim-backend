import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ApiCacheService {
  private readonly logger = new Logger(ApiCacheService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hit → renvoie le payload caché. Miss/expired → exécute `fetcher`, persiste, renvoie.
   * Les erreurs du fetcher remontent telles quelles ; aucun négatif n'est mis en cache.
   */
  async getOrFetch<T>(
    key: string,
    ttlSeconds: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const now = new Date();
    const hit = await this.prisma.apiCache.findUnique({
      where: { cacheKey: key },
    });
    if (hit && hit.expiresAt > now) {
      return hit.payload as T;
    }

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

  /** Récupère un payload non expiré, ou null. Pas de fetcher — c'est un get pur. */
  async get<T>(key: string): Promise<T | null> {
    const row = await this.prisma.apiCache.findUnique({
      where: { cacheKey: key },
    });
    if (!row || row.expiresAt <= new Date()) return null;
    return row.payload as T;
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
