// Codes des types de collection — miroir applicatif du seed `prisma/seed.ts`.
// Ajouter un type = ajouter ici PUIS dans le seed PUIS `prisma db seed`.
export const COLLECTION_TYPE_CODES = [
  'vinyl',
  'manga',
  'movie',
  'book',
  'game',
] as const;

export type CollectionTypeCode = (typeof COLLECTION_TYPE_CODES)[number];
