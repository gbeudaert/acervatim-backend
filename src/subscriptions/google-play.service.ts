import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleAuth } from 'google-auth-library';
import {
  androidpublisher,
  androidpublisher_v3,
} from '@googleapis/androidpublisher';

/**
 * État courant d'un abonnement vu côté Google Play, projeté sur ce dont on a
 * besoin pour upsert la row `subscriptions`. On ne fuit pas le type complet
 * de googleapis hors de ce service.
 */
export interface PlaySubscriptionSnapshot {
  /** SUBSCRIPTION_STATE_ACTIVE etc. (cf. subscription-status.ts). */
  state: string;
  /** epoch ms ; tirée de lineItems[0].expiryTime. */
  expiresAt: number;
  autoRenew: boolean;
  productId: string;
}

@Injectable()
export class GooglePlayService implements OnModuleInit {
  private readonly logger = new Logger(GooglePlayService.name);
  private packageName?: string;
  private publisher?: androidpublisher_v3.Androidpublisher;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.packageName = this.config.get<string>('GOOGLE_PLAY_PACKAGE_NAME');
    const saBase64 = this.config.get<string>(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
    );
    if (!this.packageName || !saBase64) {
      this.logger.warn(
        'Google Play not configured (GOOGLE_PLAY_PACKAGE_NAME / GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) — verify + RTDN will return 503',
      );
      return;
    }
    try {
      const credentials = JSON.parse(
        Buffer.from(saBase64, 'base64').toString('utf8'),
      );
      const auth = new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      });
      this.publisher = androidpublisher({ version: 'v3', auth });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Google Play SA JSON parse failed: ${msg}`);
    }
  }

  /**
   * Récupère l'état courant d'un abonnement via `subscriptionsv2.get`. Retourne
   * null si l'achat n'existe pas (404) ou si la ligne ne contient pas d'item.
   * Lance ServiceUnavailableException si le service n'est pas configuré.
   */
  async getSubscription(
    purchaseToken: string,
  ): Promise<PlaySubscriptionSnapshot | null> {
    const { publisher, packageName } = this.requireReady();
    const res = await publisher.purchases.subscriptionsv2.get({
      packageName,
      token: purchaseToken,
    });
    return this.toSnapshot(res.data);
  }

  private toSnapshot(
    data: androidpublisher_v3.Schema$SubscriptionPurchaseV2,
  ): PlaySubscriptionSnapshot | null {
    const state = data.subscriptionState;
    const lineItem = data.lineItems?.[0];
    if (!state || !lineItem?.expiryTime || !lineItem.productId) return null;
    const expiresAt = new Date(lineItem.expiryTime).getTime();
    if (!Number.isFinite(expiresAt)) return null;
    return {
      state,
      expiresAt,
      autoRenew: lineItem.autoRenewingPlan?.autoRenewEnabled ?? false,
      productId: lineItem.productId,
    };
  }

  private requireReady(): {
    publisher: androidpublisher_v3.Androidpublisher;
    packageName: string;
  } {
    if (!this.publisher || !this.packageName) {
      throw new ServiceUnavailableException('google-play: not configured');
    }
    return { publisher: this.publisher, packageName: this.packageName };
  }
}
