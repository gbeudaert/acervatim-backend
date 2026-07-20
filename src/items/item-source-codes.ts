// Sources externes supportées pour les items.
// Ajouter une source = ajouter ici PUIS un adapter (sprint 04).
// `bnf` et `mangadex` n'ont pas d'adapter dédié (sources publiques interrogées via BnfService /
// MangaDexCoverService pour le pivot ISBN→MangaDex) : un item y référence sa notice/identité ;
// SourceSnapshotService stocke la réf sans snapshot faute d'adapter (cf. backend#2, repli bnf_only,
// et le chemin nominal `source='mangadex'` du plan MangaDex).
export const ITEM_SOURCE_CODES = [
  'discogs',
  'mal',
  'tmdb',
  'bnf',
  'mangadex',
] as const;

export type ItemSourceCode = (typeof ITEM_SOURCE_CODES)[number];
