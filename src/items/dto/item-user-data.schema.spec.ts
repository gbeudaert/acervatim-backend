import {
  DEFAULT_ITEM_STATUS,
  DEFAULT_PLAY_COUNT,
  ItemUserDataSchema,
  resolveItemStatus,
  resolvePlayCount,
} from './item-user-data.schema';

describe('ItemUserDataSchema — status', () => {
  it.each(['OWNED', 'WISHLIST', 'IGNORED'])('accepte %s', (status) => {
    expect(ItemUserDataSchema.parse({ status }).status).toBe(status);
  });

  it('accepte null (statut explicitement effacé)', () => {
    expect(ItemUserDataSchema.parse({ status: null }).status).toBeNull();
  });

  it('accepte l’absence de status (PATCH partiel)', () => {
    const parsed = ItemUserDataSchema.parse({ rating: 4 });
    expect(parsed.status).toBeUndefined();
    expect(parsed.rating).toBe(4);
  });

  it('rejette une valeur inconnue', () => {
    expect(() => ItemUserDataSchema.parse({ status: 'FOO' })).toThrow();
    expect(() => ItemUserDataSchema.parse({ status: 'owned' })).toThrow();
  });

  it('rejette toujours une clé inconnue (.strict conservé)', () => {
    expect(() => ItemUserDataSchema.parse({ statuss: 'OWNED' })).toThrow();
  });
});

describe('resolveItemStatus — défaut serveur', () => {
  it('renvoie OWNED par défaut', () => {
    expect(DEFAULT_ITEM_STATUS).toBe('OWNED');
  });

  it('renvoie le statut quand il est renseigné', () => {
    expect(resolveItemStatus({ status: 'WISHLIST' })).toBe('WISHLIST');
    expect(resolveItemStatus({ status: 'IGNORED' })).toBe('IGNORED');
  });

  it('retombe sur OWNED pour un item d’avant le champ (absent, null, userData vide)', () => {
    expect(resolveItemStatus({})).toBe('OWNED');
    expect(resolveItemStatus({ status: null })).toBe('OWNED');
    expect(resolveItemStatus({ rating: 3 })).toBe('OWNED');
    expect(resolveItemStatus(null)).toBe('OWNED');
    expect(resolveItemStatus(undefined)).toBe('OWNED');
  });

  it('retombe sur OWNED sur une valeur non reconnue en base (jamais de crash en lecture)', () => {
    expect(resolveItemStatus({ status: 'FOO' })).toBe('OWNED');
    expect(resolveItemStatus({ status: 42 })).toBe('OWNED');
  });
});

describe('ItemUserDataSchema — playCount', () => {
  it('accepte un entier positif ou zéro', () => {
    expect(ItemUserDataSchema.parse({ playCount: 12 }).playCount).toBe(12);
    expect(ItemUserDataSchema.parse({ playCount: 0 }).playCount).toBe(0);
  });

  it('accepte null (compteur explicitement effacé)', () => {
    expect(ItemUserDataSchema.parse({ playCount: null }).playCount).toBeNull();
  });

  it('accepte l’absence de playCount (PATCH partiel)', () => {
    expect(ItemUserDataSchema.parse({ rating: 4 }).playCount).toBeUndefined();
  });

  it('rejette un négatif et un non-entier', () => {
    expect(() => ItemUserDataSchema.parse({ playCount: -1 })).toThrow();
    expect(() => ItemUserDataSchema.parse({ playCount: 1.5 })).toThrow();
    expect(() => ItemUserDataSchema.parse({ playCount: '3' })).toThrow();
  });
});

describe('resolvePlayCount — défaut serveur', () => {
  it('vaut 0 par défaut', () => {
    expect(DEFAULT_PLAY_COUNT).toBe(0);
  });

  it('renvoie le compteur quand il est renseigné', () => {
    expect(resolvePlayCount({ playCount: 12 })).toBe(12);
    expect(resolvePlayCount({ playCount: 0 })).toBe(0);
  });

  it('retombe sur 0 pour un item d’avant le champ (absent, null, userData vide)', () => {
    expect(resolvePlayCount({})).toBe(0);
    expect(resolvePlayCount({ playCount: null })).toBe(0);
    expect(resolvePlayCount({ rating: 3 })).toBe(0);
    expect(resolvePlayCount(null)).toBe(0);
    expect(resolvePlayCount(undefined)).toBe(0);
  });

  it('retombe sur 0 sur une valeur aberrante en base (jamais de crash en lecture)', () => {
    expect(resolvePlayCount({ playCount: -4 })).toBe(0);
    expect(resolvePlayCount({ playCount: 2.5 })).toBe(0);
    expect(resolvePlayCount({ playCount: 'douze' })).toBe(0);
  });
});
