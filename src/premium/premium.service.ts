import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type PremiumSource = 'grant' | 'subscription' | 'none';

export interface PremiumStatus {
  isPremium: boolean;
  source: PremiumSource;
  /** epoch ms ; null = pas premium OU grant permanent. */
  expiresAt: number | null;
}

/**
 * Statuts d'abonnement Google Play considérés actifs (Play laisse le user premium
 * pendant `grace_period` et `cancelled` tant que `expiresAt` n'est pas dépassé).
 */
const ACTIVE_SUB_STATUSES = new Set(['active', 'grace_period', 'cancelled']);

@Injectable()
export class PremiumService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Premium = grant actif OR sub active.
   * Le grant est prioritaire : s'il est posé manuellement (script, invitation),
   * on l'utilise même quand une sub existe — utile pour les beta-testers qui
   * passent quand même par Google Play en parallèle.
   */
  async getStatus(userId: string): Promise<PremiumStatus> {
    const [grant, sub] = await Promise.all([
      this.prisma.premiumGrant.findUnique({ where: { userId } }),
      this.prisma.subscription.findUnique({ where: { userId } }),
    ]);
    const now = Date.now();

    if (grant && (!grant.expiresAt || Number(grant.expiresAt) > now)) {
      return {
        isPremium: true,
        source: 'grant',
        expiresAt: grant.expiresAt ? Number(grant.expiresAt) : null,
      };
    }
    if (
      sub &&
      ACTIVE_SUB_STATUSES.has(sub.status) &&
      Number(sub.expiresAt) > now
    ) {
      return {
        isPremium: true,
        source: 'subscription',
        expiresAt: Number(sub.expiresAt),
      };
    }
    return { isPremium: false, source: 'none', expiresAt: null };
  }
}
