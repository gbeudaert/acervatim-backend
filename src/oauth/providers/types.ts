import { CollectionTypeCode } from '../../collections/collection-type-codes';
import { ItemSourceCode } from '../../items/item-source-codes';

/**
 * Représentation normalisée d'un résultat externe.
 * Chaque adapter mappe sa réponse brute vers ce shape avant retour à l'API.
 * `rawData` conserve la réponse d'origine pour rejouer le mapping si besoin.
 */
export interface UnifiedItem {
  source: ItemSourceCode;
  sourceId: string;
  mediaType: CollectionTypeCode;
  title: string;
  creators: string[];
  releaseDate?: string;
  coverUrl?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  rawData: unknown;
}

export interface AdapterContext {
  userId: string;
  cursor?: string;
  limit: number;
}

export interface AdapterSearchResult {
  items: UnifiedItem[];
  nextCursor: string | null;
}

/**
 * Contrat unique pour toute source externe (Discogs, MAL, TMDB, ...).
 * `search` est le point d'entrée du `GET /v1/search`.
 * `fetchDetails` sert au `POST /v1/items` pour récupérer le détail complet d'une ressource.
 */
export interface SourceAdapter {
  readonly source: ItemSourceCode;
  readonly mediaType: CollectionTypeCode;

  search(query: string, ctx: AdapterContext): Promise<AdapterSearchResult>;
  fetchDetails(id: string, ctx: AdapterContext): Promise<UnifiedItem>;
}
