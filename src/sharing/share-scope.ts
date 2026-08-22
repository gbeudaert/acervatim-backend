/**
 * Portée d'un partage : ce que le membre voit de la collection.
 *
 * Stockées telles quelles dans `collection_shares.scope` et acceptées telles quelles sur le fil —
 * pas de mapping entre l'API et la base, une valeur de moins à faire diverger.
 *
 * Le filtrage effectif est le travail de S4 : ici la portée n'est qu'une donnée, jamais interprétée.
 * S4 la lira depuis `CollectionAccess` et l'injectera **serveur-side** dans le `where` — un client
 * ne la fournit jamais en lecture.
 */
export const SHARE_SCOPES = ['all', 'owned', 'wantlist'] as const;
export type ShareScope = (typeof SHARE_SCOPES)[number];
