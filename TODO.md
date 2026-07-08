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
