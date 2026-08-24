-- Rupture nette (S5). Le modele passe de "un partage = une collection + une portee" a
-- "un partage = N collections, chacune avec son jeu de statuts". La migration precedente a
-- supprime `collection_id` et `scope` : les partages emis sous l'ancien modele n'ont donc plus
-- aucune collection, et leur code accorderait une adhesion qui ne montre rien.
--
-- Aucune conversion n'est tentee : la fonctionnalite n'avait pas encore ete mise entre les mains
-- d'utilisateurs, et un partage sans intention exprimee ne se devine pas. Les codes deja emis
-- cessent de valoir. `collection_share_members` et `collection_share_entries` cascadent.
DELETE FROM `collection_shares`;
