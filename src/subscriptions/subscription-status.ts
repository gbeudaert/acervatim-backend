/**
 * Statuts internes — Google Play utilise des enum SUBSCRIPTION_STATE_*, on les
 * mappe vers nos valeurs de la colonne `subscriptions.status` (VarChar(16)).
 *
 * Décision : 'cancelled' garde accès tant que `expiresAt > now` (user a payé
 * jusqu'à la fin de la période), 'expired'/'on_hold'/'paused' = pas premium.
 * Voir PremiumService.ACTIVE_SUB_STATUSES.
 */
export type SubscriptionStatus =
  | 'active'
  | 'grace_period'
  | 'on_hold'
  | 'paused'
  | 'cancelled'
  | 'expired';

export const GOOGLE_STATE_TO_STATUS: Record<string, SubscriptionStatus> = {
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'grace_period',
  SUBSCRIPTION_STATE_ON_HOLD: 'on_hold',
  SUBSCRIPTION_STATE_PAUSED: 'paused',
  SUBSCRIPTION_STATE_CANCELED: 'cancelled',
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
};

export function mapGoogleState(
  state: string | null | undefined,
): SubscriptionStatus {
  if (!state) return 'expired';
  return GOOGLE_STATE_TO_STATUS[state] ?? 'expired';
}
