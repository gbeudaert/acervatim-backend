# TODO interne — backend Acervatim

Notes de travail (backlog technique). La doc de conception vit dans le dépôt `acervatim-docs`
(agent/ + site public) ; ici on ne garde que des rappels d'actions différées.

## Passerelle sortante BullMQ — P3 (durcissement) restant

Chantier détaillé : `acervatim-docs/agent/backend/scan-asynchrone-bullmq.md`.
Faits : P0 (gbooks), P1 (import série), P2 (bnf/tmdb/mal/discogs + retrait token bucket SQL),
P3 circuit-breaker Redis, P3 métriques de files (`GET /admin/queues` + log périodique).

- [ ] **Bull Board** — dashboard visuel des files. **Différé (overkill pour l'instant)** : les
      métriques (`GET /admin/queues` + logs `QueueMetricsService`) suffisent au besoin courant, et
      Bull Board ajoute une surface d'authentification/exposition à sécuriser. À reconsidérer si le
      débogage des files devient récurrent.
- [ ] **Calibrage des limiters** — ajuster `max`/`duration` par file (`*.processor.ts`) sur les
      budgets réels des sources, à partir des métriques de backlog/débit **sous charge réelle**.
- [ ] **Compteur d'échecs dédié** — `failed` de `getJobCounts()` est ~0 (`removeOnFail: true`) ;
      les échecs ne sont visibles que dans les logs des workers. Envisager un compteur central
      (`@OnWorkerEvent('failed')`) si un taux d'échec agrégé devient utile.
- [ ] **App — WorkManager** (repo `acervatim-app`) : reprise en arrière-plan du polling d'import
      de série (reporté de P1, aujourd'hui polling ViewModel).
- [ ] **Validation app bout-en-bout** de l'import série async contre un backend avec Redis.

## Jaquettes — source alternative pour les trous Google Books

- [ ] **Source de jaquette de repli quand Google Books n'a pas l'image.** Certains tomes n'ont
      **aucune** jaquette chez Google Books (notice sans `imageLinks`), indépendamment du `country`
      (FR **et** US renvoient les mêmes notices non illustrées) — vérifié 2026-07-10 sur **Black Torch
      T1-5** (standard) et **SNK Éd. colossale T3/T4** ; les seules notices illustrées sont des
      éditions étrangères (bare-number) ou hors-séries, rejetées à juste titre. Ce n'est donc PAS un
      503 (corrigé : repli `intitle:` + retry) ni un matching trop strict — c'est un trou de données.
      Le log `gbooks: intitle no-match …` (ajouté) permet de repérer ces cas en prod. Pistes de repli :
      notice illustrée BnF/Electre, ISBN éditeur, ou provider tiers (Nautiljon/AniList…). Décision
      produit à trancher.

## Jaquettes — import côté serveur pour les comptes premium

- [ ] **Importer et héberger les jaquettes côté backend, pour les comptes premium.** Le serveur ne
      stocke aujourd'hui **aucune image** : il ne transmet qu'une `coverUrl` de provider, et c'est
      l'app qui télécharge le fichier à l'enregistrement (`CoverStorageImpl.saveFromUrl`). Deux cas
      n'ont donc jamais d'image — une **collection reçue en partage** (le destinataire n'a aucun
      fichier local) et un item **tiré par la synchro** depuis un autre appareil. Le repli distant de
      `RecordCover` existe pour ça mais ne peut pas fonctionner : l'app n'embarque pas de fetcher
      réseau Coil (`coil-network-okhttp` absent au classpath) — constaté le 2026-08-26.
      L'enjeu dépasse le confort : faire charger au destinataire une URL **écrite par le partageur**
      (`unifiedData.coverUrl`, validée en `z.string().url()` seulement, donc sans contrainte de
      schéma ni d'hôte) expose son IP à un serveur choisi par l'émetteur et lui fait décoder une
      image d'origine inconnue. Un import serveur ferme les deux : le backend valide, télécharge une
      fois, et sert depuis son propre domaine.
      À trancher : stockage (disque / objet), plafonds (taille par image, nombre par compte),
      schémas autorisés (`https` seul), reprise/expiration, et le devenir des images quand un compte
      cesse d'être premium.
- [ ] **App** (repo `acervatim-app`) : consommer les URLs servies par le backend — ou, en attendant,
      brancher `coil-network-okhttp` avec un client dédié (timeouts, plafond de taille, **pas**
      d'`AuthInterceptor`) et un filtre `https`. Ajout de dépendance à valider (cf. `AGENTS.md`).

## Import « manuel » d'une série manga (recherche par titre)

- [ ] **Ajouter une série manga en la cherchant par titre, sans en posséder aucun tome.** Cas
      d'usage : taper « frieren » et mettre la série en **wishlist**. Aujourd'hui le seul chemin vers
      une série complète est le **scan d'un tome** (`series/import?barcode=`) : il faut donc déjà en
      posséder un, soit l'inverse du besoin.

      **Cadré dans `acervatim-docs/spec-macro-import-serie-manga.md`** (2026-08-26) — l'audit y est,
      ne pas le refaire. En deux lignes : la chaîne d'import fonctionne **déjà** à partir d'un titre
      (`enumerateEdition` interroge la BnF en `bib.title all`, `import-jobs` est clé sur le titre, et
      l'import crée déjà les tomes non scannés en `WISHLIST`). Ne manquent que la **découverte** (choisir
      la bonne série sans l'auteur que fournissait l'ISBN — cf. le commentaire « Frieren » de
      `chooseIdentity`) et la **projection** des éditions disponibles, dont les notices sont déjà
      chargées et cachées.

      Découpage : **SD1** découverte série + éditions · **SD2** `edition` dans `MangaSerieSchema` (sans
      quoi le choix est perdu à la sync, le schéma étant en `.strip()`) · **AD1** écran de recherche ·
      **AD2** import sans tome possédé + migration Room v8.

      Arbitrage acté : deux éditions d'une même série **coexistent** — ce qui corrige au passage la
      divergence à l'origine du `409 item déjà ajouté (série + volume)` (unicité
      `[userId, nodeId, volume]` côté serveur, absente côté app).
