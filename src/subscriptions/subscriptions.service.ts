import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { GooglePlayService } from './google-play.service';
import { mapGoogleState, SubscriptionStatus } from './subscription-status';

export interface VerifyResult {
  status: SubscriptionStatus;
  expiresAt: number;
  autoRenew: boolean;
  productId: string;
}

export interface RtdnHandleResult {
  /** 'updated' = row mise à jour, 'pending_verify' = token inconnu (attente du /verify), 'ignored' = pas de subscriptionNotification. */
  outcome: 'updated' | 'pending_verify' | 'ignored';
}

interface PubsubMessage {
  message?: { data?: string; messageId?: string };
}

interface RtdnPayload {
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: {
    notificationType?: number;
    purchaseToken?: string;
    subscriptionId?: string;
  };
}

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly googlePlay: GooglePlayService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Valide un purchase token auprès de Google Play et upsert la row.
   * Le sub est lié au `userId` (PK) — un user a au plus une row courante.
   * Idempotent : appel répété écrase avec le même état Google.
   */
  async handleVerify(
    userId: string,
    purchaseToken: string,
    productId: string,
  ): Promise<VerifyResult> {
    const snapshot = await this.googlePlay.getSubscription(purchaseToken);
    if (!snapshot) {
      throw new BadRequestException('subscription not found on Google Play');
    }
    if (snapshot.productId !== productId) {
      // Le purchase token vient effectivement d'un produit, mais pas celui que le client prétend.
      throw new BadRequestException('productId mismatch');
    }
    const status = mapGoogleState(snapshot.state);

    await this.prisma.subscription.upsert({
      where: { userId },
      create: {
        userId,
        status,
        productId: snapshot.productId,
        purchaseToken,
        expiresAt: BigInt(snapshot.expiresAt),
        autoRenew: snapshot.autoRenew,
      },
      update: {
        status,
        productId: snapshot.productId,
        purchaseToken,
        expiresAt: BigInt(snapshot.expiresAt),
        autoRenew: snapshot.autoRenew,
        lastVerifiedAt: new Date(),
      },
    });

    await this.auditLog.record({
      userId,
      action: 'subscription.verify',
      target: userId,
      metadata: { status, productId: snapshot.productId },
    });

    this.logger.log(
      `subscription.verify user=${userId.slice(0, 8)}… status=${status}`,
    );

    return {
      status,
      expiresAt: snapshot.expiresAt,
      autoRenew: snapshot.autoRenew,
      productId: snapshot.productId,
    };
  }

  /**
   * Traite un push Pub/Sub RTDN (Real-Time Developer Notification).
   * Le body Pub/Sub est `{ message: { data: base64(json) } }`. Le JSON décodé
   * contient `subscriptionNotification.{purchaseToken,notificationType,...}`.
   *
   * Stratégie : retrouver le user via `purchase_token`, re-query Google pour
   * la source de vérité, update. Si le token n'est pas connu (RTDN avant
   * verify initial), on ACK 200 sans rien faire.
   */
  async handleRtdn(body: PubsubMessage): Promise<RtdnHandleResult> {
    const dataBase64 = body?.message?.data;
    if (!dataBase64) {
      throw new BadRequestException('missing pub/sub message data');
    }
    let payload: RtdnPayload;
    try {
      payload = JSON.parse(Buffer.from(dataBase64, 'base64').toString('utf8'));
    } catch {
      throw new BadRequestException('invalid pub/sub payload');
    }

    const notif = payload.subscriptionNotification;
    if (!notif?.purchaseToken) {
      // testNotification, otp, voidedPurchase… : on ACK et on log seulement.
      await this.auditLog.record({
        action: 'subscription.rtdn.received',
        metadata: { ignored: true, payload: payload as never },
      });
      return { outcome: 'ignored' };
    }

    const existing = await this.prisma.subscription.findUnique({
      where: { purchaseToken: notif.purchaseToken },
      select: { userId: true },
    });
    if (!existing) {
      // RTDN reçu avant l'appel /verify initial — on ACK pour ne pas que Google
      // retente en boucle. L'app appellera /verify ensuite.
      await this.auditLog.record({
        action: 'subscription.rtdn.received',
        metadata: {
          outcome: 'pending_verify',
          notificationType: notif.notificationType,
        },
      });
      return { outcome: 'pending_verify' };
    }

    const snapshot = await this.googlePlay.getSubscription(notif.purchaseToken);
    if (!snapshot) {
      throw new NotFoundException('subscription not found on Google Play');
    }
    const status = mapGoogleState(snapshot.state);

    await this.prisma.subscription.update({
      where: { userId: existing.userId },
      data: {
        status,
        expiresAt: BigInt(snapshot.expiresAt),
        autoRenew: snapshot.autoRenew,
        lastVerifiedAt: new Date(),
      },
    });

    await this.auditLog.record({
      userId: existing.userId,
      action: 'subscription.rtdn.received',
      target: existing.userId,
      metadata: {
        outcome: 'updated',
        status,
        notificationType: notif.notificationType,
      },
    });

    this.logger.log(
      `subscription.rtdn user=${existing.userId.slice(0, 8)}… status=${status} type=${notif.notificationType ?? '?'}`,
    );

    return { outcome: 'updated' };
  }
}
