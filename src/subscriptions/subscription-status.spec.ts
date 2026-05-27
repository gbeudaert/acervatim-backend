import { mapGoogleState } from './subscription-status';

describe('mapGoogleState', () => {
  it.each([
    ['SUBSCRIPTION_STATE_ACTIVE', 'active'],
    ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'grace_period'],
    ['SUBSCRIPTION_STATE_ON_HOLD', 'on_hold'],
    ['SUBSCRIPTION_STATE_PAUSED', 'paused'],
    ['SUBSCRIPTION_STATE_CANCELED', 'cancelled'],
    ['SUBSCRIPTION_STATE_EXPIRED', 'expired'],
  ])('mappe %s → %s', (state, expected) => {
    expect(mapGoogleState(state)).toBe(expected);
  });

  it('null → expired (fallback sécurisé)', () => {
    expect(mapGoogleState(null)).toBe('expired');
    expect(mapGoogleState(undefined)).toBe('expired');
  });

  it('état Google inconnu → expired (fallback sécurisé)', () => {
    expect(mapGoogleState('SUBSCRIPTION_STATE_FUTURE_VALUE')).toBe('expired');
  });
});
