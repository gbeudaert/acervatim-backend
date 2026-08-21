import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TechnicalLimitException } from './technical-limit.exception';

/**
 * Plafonds **techniques**, identiques pour tous les comptes (S2).
 *
 * Ils ne matérialisent aucun palier : la synchronisation est premium-only, et le premium ne les
 * lève pas. Ce sont des garde-fous anti-emballement — un client qui boucle, un import qui dérape —
 * volontairement hauts : un usage humain, même intensif, ne doit jamais les voir. Ils ne sont pas
 * communiqués à l'utilisateur et aucun endpoint ne les expose.
 */
export const TECHNICAL_LIMITS = {
  collections: 500,
  items: 100_000,
} as const;

/**
 * Accepte un client transactionnel (Prisma.TransactionClient) ou le client root
 * — permet à l'appelant d'enrôler le check dans la transaction de création
 * pour réduire la fenêtre TOCTOU.
 */
type DbClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class LimitsService {
  constructor(private readonly prisma: PrismaService) {}

  async assertCanCreateCollection(
    userId: string,
    db?: DbClient,
  ): Promise<void> {
    const client = db ?? this.prisma;
    const used = await client.collection.count({ where: { userId } });
    if (used >= TECHNICAL_LIMITS.collections) {
      throw new TechnicalLimitException(
        `technical-limit: max ${TECHNICAL_LIMITS.collections} collections`,
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
    if (used >= TECHNICAL_LIMITS.items) {
      throw new TechnicalLimitException(
        `technical-limit: max ${TECHNICAL_LIMITS.items} items`,
      );
    }
  }
}
