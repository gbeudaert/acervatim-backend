import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QuotaExceededException } from './quota-exceeded.exception';

/**
 * Limites free tier — hardcodées au sprint 03.
 * Au sprint 05, substituer par un lookup `premiumService.getLimits(userId)`.
 */
export const FREE_TIER_LIMITS = {
  collections: 10,
  items: 500,
} as const;

export interface QuotaSummary {
  collections: { used: number; max: number };
  items: { used: number; max: number };
}

/**
 * Accepte un client transactionnel (Prisma.TransactionClient) ou le client root
 * — permet à l'appelant d'enrôler le check dans la transaction de création
 * pour réduire la fenêtre TOCTOU.
 */
type DbClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class QuotaService {
  constructor(private readonly prisma: PrismaService) {}

  async assertCanCreateCollection(
    userId: string,
    db?: DbClient,
  ): Promise<void> {
    const client = db ?? this.prisma;
    const used = await client.collection.count({ where: { userId } });
    if (used >= FREE_TIER_LIMITS.collections) {
      throw new QuotaExceededException(
        `quota-exceeded: max ${FREE_TIER_LIMITS.collections} collections`,
      );
    }
  }

  async assertCanCreateItem(userId: string, db?: DbClient): Promise<void> {
    const client = db ?? this.prisma;
    const agg = await client.collection.aggregate({
      where: { userId },
      _sum: { itemCount: true },
    });
    const used = agg._sum.itemCount ?? 0;
    if (used >= FREE_TIER_LIMITS.items) {
      throw new QuotaExceededException(
        `quota-exceeded: max ${FREE_TIER_LIMITS.items} items`,
      );
    }
  }

  async getQuotaSummary(userId: string): Promise<QuotaSummary> {
    const [collectionsUsed, itemsAgg] = await Promise.all([
      this.prisma.collection.count({ where: { userId } }),
      this.prisma.collection.aggregate({
        where: { userId },
        _sum: { itemCount: true },
      }),
    ]);
    return {
      collections: {
        used: collectionsUsed,
        max: FREE_TIER_LIMITS.collections,
      },
      items: {
        used: itemsAgg._sum.itemCount ?? 0,
        max: FREE_TIER_LIMITS.items,
      },
    };
  }
}
