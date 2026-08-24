import { itemVisibleUnderStatuses } from './share-filter.service';
import {
  ALL_SHARE_STATUSES,
  isAllStatuses,
  normalizeStatuses,
  parseStatuses,
  unionStatuses,
} from './share-statuses';
import { sharedItemUserData, sharedNodeUserData } from './shared-user-data';

const OWNED = ['OWNED'] as const;
const WANTED = ['WISHLIST'] as const;

describe('itemVisibleUnderStatuses', () => {
  it('laisse tout passer quand les trois statuts sont exposes', () => {
    for (const status of ALL_SHARE_STATUSES) {
      expect(itemVisibleUnderStatuses({ status }, ALL_SHARE_STATUSES)).toBe(
        true,
      );
    }
    expect(itemVisibleUnderStatuses({}, ALL_SHARE_STATUSES)).toBe(true);
  });

  it('possedes seuls : ni les desires ni les ignores', () => {
    expect(itemVisibleUnderStatuses({ status: 'OWNED' }, OWNED)).toBe(true);
    expect(itemVisibleUnderStatuses({ status: 'WISHLIST' }, OWNED)).toBe(false);
    expect(itemVisibleUnderStatuses({ status: 'IGNORED' }, OWNED)).toBe(false);
  });

  it('desires seuls : ni les possedes ni les ignores', () => {
    expect(itemVisibleUnderStatuses({ status: 'WISHLIST' }, WANTED)).toBe(true);
    expect(itemVisibleUnderStatuses({ status: 'OWNED' }, WANTED)).toBe(false);
    expect(itemVisibleUnderStatuses({ status: 'IGNORED' }, WANTED)).toBe(false);
  });

  // Ce que les portees all/owned/wantlist ne savaient pas exprimer.
  it('combinaison libre : tout sauf les ignores', () => {
    const statuses = ['OWNED', 'WISHLIST'] as const;
    expect(itemVisibleUnderStatuses({ status: 'OWNED' }, statuses)).toBe(true);
    expect(itemVisibleUnderStatuses({ status: 'WISHLIST' }, statuses)).toBe(
      true,
    );
    expect(itemVisibleUnderStatuses({ status: 'IGNORED' }, statuses)).toBe(
      false,
    );
  });

  // Meme regle que `resolveItemStatus` (S1) : le defaut est OWNED, il n'est pas redefini ici.
  it('statut absent, null ou inconnu = OWNED', () => {
    for (const userData of [
      {},
      { status: null },
      { status: 'wishlist' }, // casse differente : pas un statut connu
      { status: 'PARTI_EN_FUMEE' },
      null,
      undefined,
    ]) {
      expect(itemVisibleUnderStatuses(userData, OWNED)).toBe(true);
      expect(itemVisibleUnderStatuses(userData, WANTED)).toBe(false);
    }
  });

  it('ensemble vide : rien n’est visible', () => {
    expect(itemVisibleUnderStatuses({ status: 'OWNED' }, [])).toBe(false);
    expect(itemVisibleUnderStatuses({}, [])).toBe(false);
  });
});

describe('ensembles de statuts', () => {
  it('normalise dans l’ordre canonique et dedoublonne', () => {
    expect(normalizeStatuses(['WISHLIST', 'OWNED', 'OWNED'])).toEqual([
      'OWNED',
      'WISHLIST',
    ]);
  });

  it('parse une colonne JSON en ecartant ce qui n’est pas un statut connu', () => {
    expect(parseStatuses(['OWNED', 'nope', 42, null])).toEqual(['OWNED']);
  });

  // Une ligne abimee ne doit pas ouvrir la collection entiere.
  it('parse une valeur inexploitable en ensemble vide', () => {
    expect(parseStatuses(null)).toEqual([]);
    expect(parseStatuses('OWNED')).toEqual([]);
    expect(parseStatuses({})).toEqual([]);
  });

  it('reconnait l’ensemble complet, dans n’importe quel ordre', () => {
    expect(isAllStatuses(['IGNORED', 'WISHLIST', 'OWNED'])).toBe(true);
    expect(isAllStatuses(['OWNED', 'WISHLIST'])).toBe(false);
    expect(isAllStatuses([])).toBe(false);
  });

  // Deux partages de la meme collection : le membre voit la reunion de ce que chacun accorde.
  it('unit plusieurs ensembles', () => {
    expect(unionStatuses([['OWNED'], ['WISHLIST']])).toEqual([
      'OWNED',
      'WISHLIST',
    ]);
    expect(unionStatuses([['OWNED'], ['OWNED']])).toEqual(['OWNED']);
    expect(unionStatuses([])).toEqual([]);
  });
});

describe('userData rendu a un membre', () => {
  it('item : le statut, la note, la derniere ecoute et le compteur passent', () => {
    expect(
      sharedItemUserData({
        status: 'OWNED',
        rating: 4,
        lastPlayedAt: '2026-08-01T10:00:00.000Z',
        playCount: 12,
      }),
    ).toEqual({
      status: 'OWNED',
      rating: 4,
      lastPlayedAt: '2026-08-01T10:00:00.000Z',
      playCount: 12,
    });
  });

  it('item : le prix d’achat et la note libre ne passent pas', () => {
    const masked = sharedItemUserData({
      status: 'OWNED',
      purchasePrice: 42.5,
      note: 'offert par mamie, ne pas revendre',
    });
    expect(masked).toEqual({ status: 'OWNED' });
    expect(masked.purchasePrice).toBeUndefined();
    expect(masked.note).toBeUndefined();
  });

  // Liste blanche : un champ ajoute plus tard (S1bis) reste invisible tant qu'il n'a pas ete
  // juge partageable. Le mode de defaillance est « champ manquant », jamais « champ fuite ».
  it('item : un champ inconnu de la liste blanche ne passe pas', () => {
    expect(sharedItemUserData({ champLivreEnS1bis: 'secret' })).toEqual({});
  });

  it('noeud : la note numerique passe, le commentaire libre non', () => {
    expect(
      sharedNodeUserData({ note: 8, comment: 'a relire un jour' }),
    ).toEqual({ note: 8 });
  });

  it('ne fabrique pas de cles absentes', () => {
    expect(sharedItemUserData({})).toEqual({});
    expect(sharedNodeUserData({})).toEqual({});
  });
});
