# Changelog

Toutes les évolutions notables du backend Acervatim. Le format s'inspire de
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; le versionnage suit
[SemVer](https://semver.org/lang/fr/), avec le numéro porté par `package.json` et logué au
démarrage.

Ce fichier a été ouvert à la version 0.9.0 : les versions antérieures y sont reconstituées
depuis l'historique Git, en résumé.

## [0.9.0] — 2026-08-29

### Ajouté

- **Désambiguïsation des pressages en recherche textuelle Discogs (SD1).** Une recherche
  texte renvoie 20 à 30 pressages du même album ; la charge utile porte désormais le
  numéro de catalogue, les codes-barres (normalisés en chiffres, dédupliqués) et le
  `master_id`, commun à tous les pressages d'un même album, qui permet à l'app de regrouper
  la liste.
- **Mesure du taux de hit du cache partagé.** `ApiCacheService` compte les hit/miss par
  **famille de clé déclarée par l'appelant** — jamais dérivée de la clé complète, qui porte
  la requête utilisateur et serait de cardinalité non bornée. Exposé sur
  `GET /v1/admin/queues` et logué avec les files. Relevé en dev : `discogs:search:q` à 0,25
  de hit contre 0,67 pour `barcode` — en texte, une requête utilisateur vaut environ un
  appel Discogs, donc la consommation du quota (60 req/min) suit le trafic au rapport 1:1.
- **Compteur d'écoutes `playCount` dans `userData` (SD3).** Entier >= 0, nullable ; absent
  ou `null` vaut 0 via `resolvePlayCount`, même patron que `resolveItemStatus`. Projeté en
  liste (vinyl / manga / repli) pour que la vue galerie trie sans re-fetch item par item, et
  ajouté à la liste blanche `sharedItemUserData` — même nature que `lastPlayedAt`, déjà
  partagé ; l'omettre l'aurait masqué sur le détail sans le masquer en liste.

### Modifié

- Le découpage `"Artist - Title"` des résultats de recherche Discogs (l'API ne renvoie pas
  de tableau `artists` en recherche) scinde les multi-artistes sur `" / "` et retire le
  suffixe d'homonymie `" (N)"`, comme le faisait déjà `fetchDetails`. Un nom d'artiste
  contenant lui-même `" - "` reste indécidable : seul `fetchDetails` tranche.
- La pagination de la recherche textuelle (curseur = numéro de page Discogs) est vérifiée
  de bout en bout et couverte par des tests, curseur illisible compris — il retombe page 1.

### Notes

- Aucune migration : `userData` est déjà une colonne `Json`.
- `playCount` est **déclaratif** — le serveur enregistre la valeur absolue envoyée par
  l'app, sans incrémenter ni recouper avec `lastPlayedAt`. Limite documentée dans le
  schéma : deux appareils hors ligne s'écrasent, dernier écrivain gagne.

## [0.8.1] — 2026-08-24

Version d'alignement du package sur l'image déployée ; aucun 0.8.0 n'a été publié. Elle
rassemble les sprints S1 à S5 (statut, contrat de sync, premium, partage) et deux
corrections d'identification au scan.

### Ajouté

- **`userData.status` synchronisé (S1)** et **verrouillage du miroir serveur de la
  collection (S1bis)**.
- **Synchronisation premium-only (S2)** : le gate premium remplace les anciens quotas
  gratuits.
- **Modèle `CollectionShare` et CRUD des partages (S3)** : code hors-bande sur le patron
  `Invitation` (pepper dédié `SHARE_CODE_PEPPER` requis au boot, seul le HMAC stocké, code
  en clair rendu une seule fois), six routes, `redeem` accessible hors premium avec bucket
  throttle 5/min. Aucun oracle d'existence : inconnu, révoqué, expiré, épuisé ou membre
  éjecté renvoient le même 404 `/probs/share-code-invalid`.
- **Lecture partagée et partage multi-collections (S4, S5)** : `CollectionAccess` remplace
  le `userId` — une collection reste scopée sur son propriétaire, le requérant n'apporte
  qu'un rôle (`owner` | `shared`). Le gate premium regarde le propriétaire, pas le lecteur ;
  la collection d'autrui reste un 404, jamais un 403 ; le `userData` privé est filtré à la
  sortie, c'est le rôle qui décide, jamais le client. Un partage appartient désormais à un
  utilisateur et non à une collection, et porte par collection le jeu de `statuses` exposé.
  Propriétaire et membre nomment chacun le partage pour soi. La perte du premium **suspend**
  le partage (402) au lieu de le supprimer.
- **Plafond technique de 20 000 nœuds par compte** : un nœud (série) pouvant naître d'un
  simple `unifiedData`, sa création n'est plus adossée à un appel provider, donc plus
  freinée par rien. Le plafond compte les nœuds du **compte**, pas ceux d'une collection.
- **Join des jaquettes par identité** (`SeriesCoverLookup` : `mangaId` > `malId` >
  `authors`) et **repli Google Books quand la BnF ignore l'ISBN** — nouveauté non
  cataloguée, éditeur non francophone. Nouveau job `volume-info` sur la file `gbooks`, puis
  `titleLadder` retire les tokens par la fin, avec un unique garde-fou non linguistique :
  ne tronquer que si la queue retirée contient un chiffre. Sans notice BnF, l'auteur manque
  une fois sur deux : l'identité expose donc `ambiguous` et le repli refuse quand il est
  vrai sans correspondance d'auteur. Taux mesuré : 98/137 (~72 %), ~84 % hors coffrets et
  ISBN absents de Google.
- `bounded-json` borne la taille des `unifiedData` / `userData` acceptés, partagé par les
  items et les nœuds.

### Corrigé

- **Une absence de notice BnF ne se cache plus 30 jours comme une notice.** Le TTL unique
  figeait le scan d'une nouveauté un mois après son catalogage réel ; l'absence
  (`numberOfRecords=0`) tombe à 24 h, la notice trouvée garde ses 30 jours. Un corps sans
  `<numberOfRecords>` (page d'erreur, diagnostic) redonne `bnf_unparsable` et n'est plus
  caché — il partait en fausse absence, ce qui aurait figé un incident BnF de dix minutes
  pendant 24 h.

### Rupture

- Migration des partages en rupture nette : `collection_id` / `scope` disparaissent et les
  partages émis sous l'ancien modèle sont purgés. La fonctionnalité n'ayant pas encore été
  mise entre les mains d'utilisateurs, aucune conversion n'est tentée.

### Interne

- Les instructions agent passent dans `AGENTS.md` ; `CLAUDE.md` n'est plus qu'un pointeur.

## [0.7.0] — 2026-07-20

### Modifié

- **Pivot du scan manga inversé : BnF -> MangaDex -> MAL en repli.** MangaDex fournit
  l'identité, les métadonnées, le synopsis FR, les jaquettes et `links.mal` ; le chemin
  nominal porte le `mal_id` fourni sans rappeler MAL (item `source='mangadex'`). Les
  helpers de rapprochement sont extraits de `mal.adapter` vers
  `src/common/sources/manga-matching.ts`, partagés MAL + MangaDex, avec le garde-fou
  `isSpecialArtEdition` (Colossale, Perfect, Kanzenban… contre simples retirages) appliqué
  aussi à la cascade de jaquettes.

## [0.6.2] — 2026-07-09

### Corrigé

- **Retry 503 Google Books durci.** Sous rafale, l'API renvoyait des 503 en vagues
  pluri-minutes qui laissaient des tomes sans jaquette : cadence ramenée à `concurrency:1`
  plus limiteur 4 req/s, horizon de retry job-level porté de 3 à 5 tentatives
  (15/30/60/120 s) pour traverser une vague d'environ 6 minutes, et option `maxAttempts`
  par appel — le resolver `gbooks` passe `maxAttempts:1`, le backoff exponentiel étant
  porté au niveau du job.

### Ajouté

- Log de version au démarrage (`<nom> vX.Y.Z demarre -- port=… env=…`), pour corréler un
  log de production à la révision déployée.

## [0.6.0] — 2026-07-08

### Modifié

- **Passerelle de sources sur BullMQ et Redis (P0 à P3)**, en remplacement du token bucket
  SQL qui livelockait sous rafale :
  - **P0** — Google Books derrière la file `gbooks` : throttle global tous utilisateurs
    confondus, single-flight par ISBN (`jobId` = clé de cache), cache uniquement sur 2xx,
    best-effort (Redis indisponible, échec worker ou timeout renvoient `null`, jamais
    d'exception).
  - **P1** — import de série asynchrone (fire-and-poll).
  - **P2** — BnF, TMDB, MAL et Discogs passent derrière leurs files respectives, jeton ou
    clé résolus au worker ; retrait du token bucket SQL.
  - **P3** — circuit-breaker Redis avec fast-fail 503 sur le chemin interactif, et
    observabilité des files (backlog, débit, échecs).

## [0.0.1] — 2026-05-26 au 2026-07-05

Fondations, livrées sans versionnage intermédiaire.

- **Socle et compte** : auth Google, JWT RS256, module `users` (`/me`, export RGPD,
  suppression), journal d'audit, identité anonymisée par `googleSubHash`.
- **Collections et items** : CRUD, hiérarchie de nœuds et wishlist, payload typé avec
  `sources[]`, filtres `items[in]` / `[all]` en substring insensible à la casse, quotas et
  `GET /v1/me/quota`, données personnelles `userData` (note, prix, dernière écoute).
- **Premium** : Google Play Billing (vérification et webhook RTDN), `PremiumService` et
  garde associée, cron de re-vérification des abonnements, CLI `grant-premium`.
- **Sources externes** : OAuth externe et adaptateurs de recherche, `TokenResolverService`
  (jeton utilisateur -> repli premium -> aucun) avec Problem Details
  `source-token-required`, saisie de clé personnelle TMDB, bucket partagé sur le repli
  premium, recherche vinyle par code-barres via Discogs, recherche manga par ISBN via le
  pivot BnF -> MAL, `editionMapping` et correspondance inter-édition, jaquettes par tome
  via Google Books.
- **Sécurité et tests** : revue des sprints 01 à 03 (CORS, rate-limit, bornes de payload),
  codes HTTP sémantiques sur les invitations et les quotas, specs unitaires et e2e sur les
  modules sensibles.
- **Livraison** : image de production multi-stage UBI9 (Node 24, Prisma 6, cible
  `linux/arm64`), déploiement par Quadlet Podman.
