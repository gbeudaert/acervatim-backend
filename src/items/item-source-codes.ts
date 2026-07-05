// Sources externes supportées pour les items.
// Ajouter une source = ajouter ici PUIS un adapter (sprint 04).
// `bnf` n'a pas d'adapter dédié (source publique interrogée via BnfService pour le
// pivot ISBN→MAL) : un item bnf_only y référence sa notice ; SourceSnapshotService
// stocke la réf sans snapshot faute d'adapter (cf. backend#2, repli bnf_only).
export const ITEM_SOURCE_CODES = ['discogs', 'mal', 'tmdb', 'bnf'] as const;

export type ItemSourceCode = (typeof ITEM_SOURCE_CODES)[number];
