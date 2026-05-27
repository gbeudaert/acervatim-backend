// Sources externes supportées pour les items.
// Ajouter une source = ajouter ici PUIS un adapter (sprint 04).
export const ITEM_SOURCE_CODES = ['discogs', 'mal', 'tmdb'] as const;

export type ItemSourceCode = (typeof ITEM_SOURCE_CODES)[number];
