import { CollectionTypeProfile } from './common';
import { makeFallbackProfile } from './fallback';
import { mangaProfile } from './manga';
import { vinylProfile } from './vinyl';

// Profils implémentés en V1. Les autres types (movie/book/game) tombent sur le
// fallback permissif.
const PROFILES: Record<string, CollectionTypeProfile> = {
  manga: mangaProfile,
  vinyl: vinylProfile,
};

export function getProfile(typeCode: string): CollectionTypeProfile {
  return PROFILES[typeCode] ?? makeFallbackProfile(typeCode);
}
