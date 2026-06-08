import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PremiumService } from '../../premium/premium.service';
import { QuotaExceededException } from './quota-exceeded.exception';

/**
 * Limites free tier — hardcodées au sprint 03.
 * Les comptes premium (grant actif OU sub active, cf. `PremiumService`) sont
 * illimités : les asserts passent toujours et le résumé renvoie `max: null`.
 */
export const FREE_TIER_LIMITS = {
  collections: 10,
  items: 500,
} as const;

export interface QuotaSummary {
  /** `max: null` = illimité (compte premium). */
  collections: { used: number; max: number | null };
  items: { used: number; max: number | null };
}

/**
 * Accepte un client transactionnel (Prisma.TransactionClient) ou le client root
 * — permet à l'appelant d'enrôler le check dans la transaction de création
 * pour réduire la fenêtre TOCTOU.
 */
type DbClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class QuotaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly premium: PremiumService,
  ) {}

  async assertCanCreateCollection(
    userId: string,
    db?: DbClient,
  ): Promise<void> {
    if (await this.isPremium(userId)) return;
    const client = db ?? this.prisma;
    const used = await client.collection.count({ where: { userId } });
    if (used >= FREE_TIER_LIMITS.collections) {
      throw new QuotaExceededException(
        `quota-exceeded: max ${FREE_TIER_LIMITS.collections} collections`,
      );
    }
  }

  async assertCanCreateItem(userId: string, db?: DbClient): Promise<void> {
    if (await this.isPremium(userId)) return;
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
    const [isPremium, collectionsUsed, itemsAgg] = await Promise.all([
      this.isPremium(userId),
      this.prisma.collection.count({ where: { userId } }),
      this.prisma.collection.aggregate({
        where: { userId },
        _sum: { itemCount: true },
      }),
    ]);
    return {
      collections: {
        used: collectionsUsed,
        max: isPremium ? null : FREE_TIER_LIMITS.collections,
      },
      items: {
        used: itemsAgg._sum.itemCount ?? 0,
        max: isPremium ? null : FREE_TIER_LIMITS.items,
      },
    };
  }

  /** Premium = grant actif OU sub active (cf. `PremiumService`) → illimité. */
  private async isPremium(userId: string): Promise<boolean> {
    const status = await this.premium.getStatus(userId);
    return status.isPremium;
  }
}
