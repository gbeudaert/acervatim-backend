<!-- bmad:context -->
<!-- Vérifié le 2026-08-22 contre 276ba76. Géré par bmad-project-context ; les éditions
     à l'intérieur de ce bloc sont remplacées au refresh. Garder hors marqueurs
     ce qui doit survivre. -->

## acervatim-backend

API REST d'Acervatim (NestJS, Prisma, MariaDB) : compte Google anonymisé, sync des
collections, recherche externe derrière une passerelle BullMQ, premium Google Play,
partage de collection. Dépôt interne, sans doc publique. La carte du code et les règles
transverses vivent dans `../acervatim-docs/agent/`.

## Policy

- Aucune donnée personnelle directe en base : ni email, ni nom, ni photo, ni `sub` Google
  en clair. L'identité est `users.googleSubHash` (HMAC-SHA-256 avec `SUB_HASH_PEPPER`),
  `users.id` est un UUID v4 opaque. Tout nouveau champ de `users` passe le test « est-ce
  que ça réidentifie un humain ? » avant merge.
- Aucun log ne contient de `sub`, d'email ou de token OAuth en clair : pour debug, logger
  `subHash.slice(0, 8) + '…'`.
- `SUB_HASH_PEPPER`, `ENCRYPTION_KEY`, `JWT_PRIVATE_KEY`, `INVITE_CODE_PEPPER` et
  `SHARE_CODE_PEPPER` ne sont pas rotables — perdre le pepper perd tous les comptes. Toute
  modification se propose avec un plan de migration, jamais en passant.
- Stocker les tokens OAuth externes chiffrés AES-256-GCM via `AesService`, jamais en clair.
- Ne nommer aucun matériel ni hébergeur (Raspberry Pi, NAS, AWS…) dans le code ou un
  commentaire. Les contraintes réelles sont : image `linux/arm64`, MariaDB via le provider
  Prisma `mysql`.
- Toute la documentation va dans `../acervatim-docs` : ne rien créer sous `docs/` ici.
- Pas de nouvelle dépendance sans accord préalable. Pas de refactor d'opportunité hors du
  périmètre du sprint en cours.

## Where things are

- Endpoints, modèle de données, modules, flux : `../acervatim-docs/agent/backend/INDEX.md`.
- Avant d'écrire un controller ou un DTO, lire
  `../acervatim-docs/agent/backend/contrats-api-v1.md` — Zod, RFC 9457, pagination cursor,
  filtres `[in]`/`[all]`.
- Pas de `lib/` ni de `utils/` global : tout va dans `src/common/<sous-dossier explicite>/`.

## Running and verifying

- `npm`, `npx`, `node`, `prisma`, `nest` ne se lancent jamais depuis Windows : passer par
  `./scripts/dev.ps1`, qui les exécute dans le conteneur `app`. Un lancement hôte produit
  des artefacts Prisma inutilisables dans le conteneur.
- Si aucun passe-plat ne couvre le besoin (`./scripts/dev.ps1 help`), ajouter une commande
  au wrapper plutôt que de le contourner.
- Ne pas invoquer `npm run test:e2e` : il pointe sur `test/jest-e2e.json`, absent du dépôt.
- Committer suppose la stack démarrée (`./scripts/dev.ps1 up-bg`) : le hook pre-commit
  lance Prettier dans le conteneur `app` et échoue s'il n'est pas up.

## Conventions that differ from defaults

- Validation par Zod via `nestjs-zod` (`createZodDto`) — pas de `class-validator`.
- Erreurs RFC 9457 : `application/problem+json`, `requestId` toujours présent.
- Jamais de `string_contains` Prisma sur une colonne JSON pour un contains insensible à la
  casse : sur MariaDB, `JSON_UNQUOTE(...)` ressort en `utf8mb4_bin`. Passer par du SQL
  paramétré avec `COLLATE utf8mb4_general_ci` — réf. `CollectionsService.matchingCollectionIds`.
- `searchFilter` n'est pas `filterIn` : sur `GET /v1/collections?items[in]=`, `[in]`/`[all]`
  combinent des termes de recherche en substring insensible à la casse, pas une
  appartenance exacte.
- Pas d'emoji dans le code ni dans les messages de commit.

## Known pitfalls

- PowerShell 5.1 : ni `&&` ni `||` (utiliser `; if ($?) { … }`). Écrire l'UTF-8 sans BOM via
  .NET, pas `Out-File -Encoding utf8`. Garder les sources `.ps1` en ASCII pur.

<!-- /bmad:context -->
