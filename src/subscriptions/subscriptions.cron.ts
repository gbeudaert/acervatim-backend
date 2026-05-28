import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsService } from './subscriptions.service';

/** Re-vérifier les subs qui expirent dans moins de 24h. */
const REVERIFY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CronCycleResult {
  checked: number;
  updated: number;
}

/**
 * Filet de sécurité si un RTDN a été perdu : toutes les 6h, re-vérifie auprès
 * de Google les subs encore considérés actifs qui expirent dans la fenêtre des
 * 24h. Sera déplacé dans `cron/` au sprint 06 ; posé ici pour rester avec le
 * domaine subscriptions.
 *
 * Note : déplacé au sprint 06 ne casse rien tant que `SubscriptionsModule`
 * fournit toujours `SubscriptionsService`.
 */
@Injectable()
export class SubscriptionsCronService {
  private readonly logger = new Logger(SubscriptionsCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  @Cron('0 0 */6 * * *') // sec min hour : 00:00, 06:00, 12:00, 18:00
  async reverifyExpiringSoon(): Promise<CronCycleResult> {
    const cutoff = BigInt(Date.now() + REVERIFY_WINDOW_MS);
    const due = await this.prisma.subscription.findMany({
      where: {
        status: { in: ['active', 'grace_period'] },
        expiresAt: { lt: cutoff },
      },
      select: { userId: true, purchaseToken: true },
    });

    let updated = 0;
    for (const sub of due) {
      try {
        const status = await this.subscriptions.refreshFromGoogle(
          sub.userId,
          sub.purchaseToken,
        );
        if (status !== null) updated += 1;
      } catch (err) {
        // Un échec sur un sub (token révoqué, Google 5xx…) ne doit pas stopper
        // le cycle : on log et on continue.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `reverify failed user=${sub.userId.slice(0, 8)}…: ${msg}`,
        );
      }
    }

    this.logger.log(
      `subscriptions cron: checked ${due.length}, updated ${updated}`,
    );
    return { checked: due.length, updated };
  }
}
