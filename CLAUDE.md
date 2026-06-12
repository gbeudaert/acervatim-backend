# Acervatim Backend — Règles dures pour l'agent IA

Ce fichier est chargé automatiquement à chaque session Claude Code. Il contient les **règles non négociables**. Le contexte projet détaillé est dans [docs/interne/context-ia.md](docs/interne/context-ia.md). Les sprints à implémenter sont indexés dans [docs/interne/sprints/README.md](docs/interne/sprints/README.md).

## Stack imposée

- Node.js 24.x (LTS) · NestJS 10 · Prisma 6 · MariaDB 10.5+ (provider `mysql`)
- Cible de déploiement : Raspberry Pi 4 (linux/arm64) sous Docker — le NAS Synology (armv7l) est abandonné, incompatible Prisma.
- TypeScript strict (déjà configuré dans `tsconfig.json`)
- Validation : `class-validator` + `class-transformer` (whitelist + forbidNonWhitelisted activés globalement dans `main.ts`)
- Jamais d'ajout de dépendance sans en discuter avant.

## Privacy by design — règle absolue

- **Aucune donnée perso directe en base** : pas d'email, pas de nom, pas de photo, pas de `sub` Google en clair.
- L'identité utilisateur en base = `users.googleSubHash` (HMAC-SHA-256 du `sub` Google avec `SUB_HASH_PEPPER`).
- `users.id` = UUID v4 opaque, jamais corrélable à un compte Google sans le pepper.
- Aucun log ne doit contenir le `sub` Google, un email, ni un token OAuth en clair. Pour debug, logger un préfixe de hash (`subHash.slice(0, 8) + '…'`).
- Tout nouveau champ ajouté à `users` doit passer un check « est-ce que ça réidentifie un humain ? » avant merge.

## Secrets

- `.env` n'est jamais committé (vérifier `.gitignore` au moindre doute).
- Les secrets critiques (`SUB_HASH_PEPPER`, `ENCRYPTION_KEY`, `JWT_PRIVATE_KEY`, `INVITE_CODE_PEPPER`) sont **non rotables sans coût** :
  - Perdre le pepper = perdre tous les comptes (impossible de relier un `sub` Google à un `userId`).
  - Toute modification de `SUB_HASH_PEPPER` ou `ENCRYPTION_KEY` doit être proposée explicitement avec un plan de migration.
- Les tokens OAuth externes (Discogs, MAL, TMDB) sont stockés **chiffrés AES-256-GCM** via `AesService` (à implémenter — cf. sprint 01). Jamais en clair.

## Conventions

- ORM : Prisma, schéma unique source de vérité dans `prisma/schema.prisma`.
- IDs : tous les modèles applicatifs ont un `id String @id @default(uuid()) @db.Char(36)`. UUID v4 généré par Prisma.
- Tables/colonnes : snake_case via `@map` / `@@map`. Modèles et champs en TypeScript : camelCase.
- DTOs dans `src/<feature>/dto/`. Un DTO par endpoint (create / update / query).
- Modules NestJS feature-based : un dossier par capacité (`auth/`, `users/`, `collections/`, etc.).
- Pas de `any` non commenté. Pas de `// @ts-ignore` sans justification.

## Contrats API V1 — règles dures

Ces règles s'appliquent à **tout endpoint applicatif** (les webhooks publics font exception explicite). Détails et exemples dans [docs/interne/context-ia.md §10](docs/interne/context-ia.md#10-contrats-api-v1).

### Versioning

- Préfixe global : tous les endpoints sous `/v1/...` (posé via `app.setGlobalPrefix('v1')` dans `main.ts`).
- Le `/health/*` reste **hors versioning** (infra, pas API métier).
- Une bump vers `/v2/` ne se fait que pour un changement de contrat incompatible. La V1 reste maintenue en parallèle pendant la transition.

### Validation : Zod via nestjs-zod

- **Pas de class-validator** dans le nouveau code. `nestjs-zod` fournit `ZodValidationPipe` (posé en global dans `main.ts`) et `createZodDto`.
- Un schéma Zod par DTO, exporté à côté de la classe :
  ```typescript
  const CreateCollectionSchema = z.object({
    typeCode: z.string().max(32),
    name: z.string().max(255),
    description: z.string().optional(),
  });
  export class CreateCollectionDto extends createZodDto(
    CreateCollectionSchema,
  ) {}
  ```
- Les DTOs `class-validator` existants (`src/invitations/dto/*`) seront migrés au sprint qui touche au module concerné.

### Erreurs : RFC 9457 (Problem Details)

- Content-Type : `application/problem+json`.
- Payload standard :
  ```json
  {
    "type": "https://api.acervatim/probs/validation-error",
    "title": "Invalid request payload",
    "status": 400,
    "detail": "name: String must contain at most 255 characters",
    "instance": "/v1/collections",
    "requestId": "f1c0…",
    "errors": [{ "field": "name", "code": "too_long", "message": "…" }]
  }
  ```
- `requestId` toujours présent (issu du `CorrelationIdInterceptor`).
- `type` : URI stable par classe d'erreur (`/probs/validation-error`, `/probs/not-found`, `/probs/forbidden`, …). Implémenté par un `ProblemDetailsExceptionFilter` global (sprint 01).
- Pas de leak d'internals (stack trace, requête SQL, etc.) en prod.

### Pagination : cursor only

- Query : `?cursor=<id>&limit=<n>` (limit max 100, défaut 50).
- Réponse standard pour toute liste paginée :
  ```json
  {
    "data": [ {...}, {...} ],
    "meta": {
      "pagination": {
        "nextCursor": "abc123",
        "limit": 50
      }
    }
  }
  ```
- `nextCursor: null` quand il n'y a plus de page suivante.
- Les ressources unitaires (`GET /v1/collections/:id`) retournent l'objet **brut** (sans wrapper `{ data }`) — la pagination wrapper ne concerne que les listes.

### Documentation OpenAPI

- `openapi.json` généré automatiquement à chaque bootstrap (`main.ts`) via `@nestjs/swagger` + `patchNestJsSwagger()` (nestjs-zod). Fichier ignoré par git (artefact).
- UI Swagger sur `GET /docs` exposée uniquement quand `NODE_ENV !== 'production'`.
- Tout nouveau controller doit générer un OpenAPI valide : décorateurs `@ApiBearerAuth()` sur les routes JWT-protected, `@ApiTags()` par module si besoin de regrouper.

### Filtres : `field[in]` (OR) et `field[all]` (AND)

- `?status[in]=active,pending` → `WHERE status IN ('active', 'pending')` (sémantique OR sur un même champ).
- `?tags[all]=jazz,blues` → la ressource doit posséder **tous** les éléments listés (sémantique AND, utile pour les relations many-to-many ou les colonnes JSON tableau).
- Plusieurs filtres dans la même requête se combinent en AND : `?type[in]=vinyl,manga&tags[all]=jazz,rock` = `(type IN (...)) AND (tags ALL (...))`.
- Parsing centralisé : helper `parseFilters(query, schema)` (Zod) → objet Prisma `where`. Implémenté au sprint 03.
- Les champs filtrables doivent être **whitelistés par endpoint** (schéma Zod), pas de filtre arbitraire client → SQL.
- **Deux familles d'opérateurs `[in]`/`[all]`** selon le helper (`src/common/filters/parse-filters.ts`) :
  - `filterIn` / `filterAll` : valeurs **whitelistées** (enum), **égalité exacte** (`WHERE IN`). Cas par défaut, c'est ce que décrivent les puces ci-dessus.
  - `searchFilter` : valeurs **texte libre**, matchées en **substring (contains) insensible à la casse**. Ici `[in]`/`[all]` combinent des _termes de recherche_ en OR/AND — **pas** une appartenance exacte. Seul usage actuel : `GET /v1/collections?items[in]=...&items[all]=...` (recherche sur le contenu des items). Détails dans [docs/interne/context-ia.md §10.5](docs/interne/context-ia.md#105-filtres-fieldin--fieldall).
- **Règle dure — recherche insensible à la casse sur JSON** : ne **jamais** utiliser le `string_contains` Prisma sur une colonne JSON pour un contains CI. Sur MariaDB, `JSON_UNQUOTE(...)` ressort en collation `utf8mb4_bin` (sensible à la casse) et MySQL n'a pas de `mode: 'insensitive'`. Passer par du SQL paramétré avec `COLLATE utf8mb4_general_ci` (référence : `CollectionsService.matchingCollectionIds`).

## Commandes — TOUJOURS via le wrapper, jamais en direct

**Règle dure** : `npm`, `npx`, `node`, `prisma`, `nest` ne se lancent **jamais** directement depuis Windows. Toujours passer par [`scripts/dev.ps1`](scripts/dev.ps1) qui les exécute dans le conteneur `app` (binaires Linux, OpenSSL Prisma, hostname `db` du réseau compose).

Pourquoi : Prisma génère des artefacts spécifiques à la plateforme ; lancer depuis Windows produit des binaires inutilisables dans le conteneur. Pareil pour les modules natifs npm.

```powershell
./scripts/dev.ps1 up                       # démarre la stack (foreground)
./scripts/dev.ps1 up-bg                    # background
./scripts/dev.ps1 down                     # stoppe (garde les volumes)
./scripts/dev.ps1 reset                    # stoppe + drop db_data (RESET total)
./scripts/dev.ps1 migrate <nom>            # nouvelle migration Prisma
./scripts/dev.ps1 generate                 # régénère le client Prisma
./scripts/dev.ps1 npx prisma db seed       # seed
./scripts/dev.ps1 npm install <pkg>        # ajouter une dep (dans le conteneur)
./scripts/dev.ps1 npm <args...>            # passe-plat npm
./scripts/dev.ps1 npx <args...>            # passe-plat npx
./scripts/dev.ps1 exec <cmd...>            # commande arbitraire dans le conteneur
./scripts/dev.ps1 db-shell                 # CLI MariaDB
./scripts/dev.ps1 shell                    # shell sh dans le conteneur app
./scripts/dev.ps1 setup-hooks              # active le pre-commit Prettier (une fois après clone)
```

Après un clone neuf : `./scripts/dev.ps1 setup-hooks` une fois pour pointer `core.hooksPath` vers `.husky/`. Le hook `pre-commit` exécute `lint-staged` (Prettier sur les fichiers stagés) dans le conteneur — il a besoin que la stack soit `up`.

Avant d'écrire un `npm <truc>` direct dans un sprint, un commentaire ou une instruction utilisateur : se demander si un passe-plat du wrapper existe (`./scripts/dev.ps1 help`). Si la commande n'a pas de wrapper dédié, utiliser `./scripts/dev.ps1 npm/npx/exec ...`. Si même ça ne suffit pas, **ajouter une commande au wrapper** plutôt que de contourner.

Adminer : http://localhost:8080 · App : http://localhost:3000

## Workflow Prisma

1. Modifier `prisma/schema.prisma`.
2. `./scripts/dev.ps1 migrate <nom-court>` → crée + applique la migration.
3. Le client Prisma est regénéré automatiquement.
4. Si la base est en drift (dev only) : `./scripts/dev.ps1 npx prisma migrate reset --force --skip-seed` puis re-migrate.

## PowerShell — pièges déjà rencontrés

- PS 5.1 par défaut sur Windows : pas de `&&` / `||` natifs (utiliser `; if ($?) { … }`).
- Encodage UTF-8 sans BOM via .NET, **pas** via `Out-File -Encoding utf8` (qui ajoute un BOM).
- Sources `.ps1` : ASCII pur (pas d'accent dans les commentaires).
- Toujours préférer le wrapper [`scripts/dev.ps1`](scripts/dev.ps1) à `docker compose` direct.

## Workflow par sprint

1. L'utilisateur ajoute le doc de sprint cible dans le contexte de la conversation.
2. Tu lis le sprint + ce CLAUDE.md (auto) + tout doc référencé par le sprint.
3. Tu suis la « Définition de Done » du sprint. Aucune fonctionnalité hors-périmètre.
4. À la fin : commit unique par sprint (sauf si la PR est trop grosse).

## Hors-sujet — ne pas faire

- Pas de refactor d'opportunité dans un sprint dédié à une autre feature.
- Pas de nouveau dossier `lib/` ou `utils/` global : tout va dans `src/common/` avec un sous-dossier explicite.
- Pas de docs marketing / README user-facing : ce repo est interne.
- Pas d'emojis dans le code ou les commits sauf demande explicite.
