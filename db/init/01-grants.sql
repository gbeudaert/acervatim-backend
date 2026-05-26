-- Exécuté automatiquement par l'image MariaDB officielle à la PREMIÈRE création de la base
-- (i.e. quand le volume db_data est vide). Pas re-exécuté sur les ups suivants.
-- Pour appliquer après coup sans reset : ./scripts/dev.ps1 db-grant
--
-- Permissions large pour le dev : autorise acervatim à créer/supprimer la shadow db
-- requise par `prisma migrate dev`. À NE PAS utiliser tel quel en prod.

GRANT ALL PRIVILEGES ON *.* TO 'acervatim'@'%';
FLUSH PRIVILEGES;
