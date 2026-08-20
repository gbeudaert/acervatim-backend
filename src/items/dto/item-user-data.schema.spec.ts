import {
  DEFAULT_ITEM_STATUS,
  ItemUserDataSchema,
  resolveItemStatus,
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
