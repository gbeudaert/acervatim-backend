# Politique de confidentialité — Acervatim

**Dernière mise à jour :** <DATE_PUBLICATION>
**Version :** 1.0

---

## 1. Préambule

La présente politique de confidentialité décrit la manière dont les données personnelles sont traitées dans le cadre de l'utilisation de l'application mobile **Acervatim** (l'« Application »), application Android de gestion de collections personnelles (vinyles, mangas, films, livres, jeux vidéo…) avec enrichissement de métadonnées via des services tiers.

Elle est rédigée en conformité avec le **Règlement (UE) 2016/679 du Parlement européen et du Conseil du 27 avril 2016** (« RGPD ») et la **loi n° 78-17 du 6 janvier 1978 modifiée** dite « Informatique et Libertés », ainsi qu'avec les exigences de transparence imposées par Google Play en matière de protection des données utilisateur.

### Responsable de traitement

L'Application est éditée par une personne physique agissant à titre individuel.

- **Contact pour toute question relative à la protection des données :** <CONTACT_EMAIL>

Aucun délégué à la protection des données (DPO) n'a été désigné, l'éditeur ne répondant à aucun des critères de désignation obligatoire prévus à l'article 37 du RGPD.

---

## 2. Principes directeurs : *privacy by design*

L'Application a été conçue selon le principe de **minimisation des données** (article 5.1.c du RGPD). Concrètement :

- **Aucun nom, prénom, adresse email, photo de profil ou identifiant nominatif n'est stocké** dans nos bases de données.
- L'identifiant unique de votre compte Google (`sub`) **n'est jamais stocké en clair** : il est transformé immédiatement à réception via une fonction de hachage cryptographique (HMAC-SHA-256) avec une clé secrète serveur, et seul ce résultat (un identifiant pseudonymisé) est conservé.
- Votre identifiant interne dans l'Application est un UUID v4 aléatoire, sans lien réversible avec votre identité Google.
- Les jetons d'accès aux services tiers (Discogs, MAL, TMDB) sont **chiffrés en base** avec un algorithme AES-256-GCM.
- Aucune mesure d'audience (Google Analytics, Firebase Analytics, etc.), aucun reporting de crash (Crashlytics, Sentry…) et aucune publicité ne sont intégrés à l'Application au jour de cette politique.

---

## 3. Données traitées

### 3.1 Données collectées au moment de l'authentification

Lors de la connexion via **Google Sign-In**, l'Application reçoit de Google un jeton d'identité (`id_token`) contenant techniquement votre adresse email et votre identifiant Google (`sub`).

| Donnée                          | Traitement effectué                                                   | Conservée ?                          |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------ |
| `sub` Google (identifiant)      | Haché immédiatement (HMAC-SHA-256) à réception                        | Sous forme hachée uniquement         |
| Adresse email Google            | **Non utilisée, non stockée**, ignorée à réception                    | Non                                  |
| Nom, photo de profil            | **Non demandées**, non incluses dans le scope OAuth                   | Non                                  |

### 3.2 Données générées par votre usage

| Donnée                                          | Finalité                                              | Conservation                          |
| ----------------------------------------------- | ----------------------------------------------------- | ------------------------------------- |
| Liste de vos collections (nom, type, description) | Affichage et synchronisation de vos collections      | Tant que votre compte existe          |
| Items ajoutés (vinyles, mangas, films…) avec leurs métadonnées | Affichage de votre catalogue personnel | Tant que votre compte existe          |
| Date de création, date de dernière modification | Tri et affichage                                      | Tant que la donnée associée existe    |

Ces données vous sont strictement personnelles. Elles ne sont **pas partagées avec d'autres utilisateurs** et ne font l'objet d'**aucun traitement statistique ou commercial** par l'éditeur.

### 3.3 Données liées aux services tiers que vous connectez

Si vous choisissez de connecter votre compte Discogs, MyAnimeList (MAL) ou TMDB pour enrichir vos collections, l'Application stocke :

| Donnée                              | Finalité                                                          | Conservation                                    |
| ----------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| Jeton d'accès OAuth (`access_token`)| Appels API en votre nom pour récupérer vos données                | Jusqu'à révocation par vos soins ou expiration  |
| Jeton de rafraîchissement (`refresh_token`) | Renouvellement automatique de l'accès                     | Jusqu'à révocation                              |
| Identifiant du service (`provider`) | Distinguer les comptes connectés                                  | Jusqu'à révocation                              |

Ces jetons sont **chiffrés en base avec AES-256-GCM**. La clé de chiffrement n'est jamais stockée à côté des données.

### 3.4 Données d'abonnement premium

Si vous souscrivez à un abonnement premium via Google Play Billing :

| Donnée                          | Finalité                                                  | Conservation                              |
| ------------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| Jeton d'achat Google (`purchaseToken`) | Vérification du statut auprès de Google Play API   | Durée de l'abonnement + 30 jours          |
| Identifiant produit (`productId`)| Identifier la formule souscrite                          | Durée de l'abonnement + 30 jours          |
| Statut, date d'expiration       | Déterminer si vous êtes encore premium                    | Durée de l'abonnement + 30 jours          |

Aucune information de paiement (numéro de carte, identifiants bancaires) **ne transite ni n'est stockée** par l'Application. Tout le flux de paiement est géré directement par Google Play.

### 3.5 Données techniques et de fonctionnement

| Donnée                          | Finalité                                                  | Conservation                              |
| ------------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| Cache API (réponses Discogs, MAL, TMDB) | Réduire la charge sur les API tierces et accélérer l'app | Maximum 30 jours                  |
| Compteurs de quota (rate limiting) | Empêcher l'abus des API tierces                        | Maximum 24 heures                         |
| Logs serveur (IP source, horodatage, route appelée) | Détection d'incidents et de fraudes      | 30 jours maximum                          |

Les logs **ne contiennent jamais** votre identifiant Google en clair ni votre identifiant interne complet (préfixe partiel uniquement, à des fins de corrélation).

---

## 4. Finalités et bases légales

| Finalité                                                       | Base légale (article 6 RGPD)                          |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| Permettre votre connexion à l'Application                      | Exécution du contrat (art. 6.1.b)                     |
| Stocker et synchroniser vos collections                        | Exécution du contrat (art. 6.1.b)                     |
| Connecter vos comptes Discogs / MAL / TMDB et appeler ces API en votre nom | Consentement explicite (art. 6.1.a), retirable à tout moment |
| Gérer votre abonnement premium                                 | Exécution du contrat (art. 6.1.b)                     |
| Accorder un accès premium via code d'invitation                | Exécution du contrat (art. 6.1.b)                     |
| Conserver des logs pour sécurité                               | Intérêt légitime (art. 6.1.f)                          |

---

## 5. Destinataires et sous-traitants

Vos données ne sont **jamais vendues, louées ou cédées** à des tiers à des fins commerciales.

Les destinataires techniques (sous-traitants au sens de l'article 28 RGPD) sont :

| Destinataire           | Rôle                                                         | Localisation des serveurs          |
| ---------------------- | ------------------------------------------------------------ | ---------------------------------- |
| **Google LLC**         | Authentification (Google Sign-In), facturation premium (Google Play Billing) | États-Unis (CCT et DPA applicables) |
| **Discogs**            | Données enrichies de vinyles (si vous connectez votre compte) | États-Unis                         |
| **MyAnimeList (MAL)**  | Données enrichies de mangas (si vous connectez votre compte) | Japon                              |
| **TMDB (The Movie Database)** | Données enrichies de films (si vous connectez votre compte) | États-Unis                  |

Les serveurs hébergeant les données de l'Application elle-même (collections, items, jetons chiffrés) sont **localisés en France**, sur une infrastructure auto-hébergée par l'éditeur. Aucune externalisation cloud n'est en place à ce jour.

### Transferts hors Union européenne

Les transferts éventuels vers des destinataires établis hors UE (Google, Discogs, TMDB aux États-Unis ; MAL au Japon) ne concernent que les données strictement nécessaires aux services activés par l'utilisateur, et reposent sur :
- les **clauses contractuelles types** de la Commission européenne pour les transferts vers les États-Unis (Discogs, TMDB) ;
- l'**EU-U.S. Data Privacy Framework** pour Google LLC (certification adéquate) ;
- la **décision d'adéquation** de la Commission européenne du 23 janvier 2019 pour le Japon (MAL).

---

## 6. Durée de conservation

| Catégorie de données                    | Durée                                                |
| --------------------------------------- | ---------------------------------------------------- |
| Compte utilisateur, collections, items  | Jusqu'à suppression du compte par l'utilisateur      |
| Jetons OAuth tiers (Discogs, MAL, TMDB) | Jusqu'à révocation ou suppression du compte          |
| Données d'abonnement                    | Durée de l'abonnement + 30 jours après expiration    |
| Cache API                               | 30 jours maximum, purgé automatiquement              |
| Logs serveur                            | 30 jours maximum                                     |
| Codes d'invitation non utilisés        | Jusqu'à expiration définie par l'éditeur, puis purge |
| Traces de claim d'invitation            | Jusqu'à suppression du compte                        |

Une fois votre compte supprimé, toutes les données associées (collections, items, jetons OAuth, statut premium, traces d'invitation) sont effacées **automatiquement et de manière atomique** grâce aux contraintes de suppression en cascade en base de données.

---

## 7. Vos droits

Conformément aux articles 15 à 22 du RGPD, vous disposez des droits suivants :

| Droit                                    | Description                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| **Droit d'accès** (art. 15)             | Obtenir confirmation que vos données sont traitées et en recevoir copie  |
| **Droit de rectification** (art. 16)    | Faire corriger toute donnée inexacte vous concernant                     |
| **Droit à l'effacement** (art. 17)      | Demander la suppression de votre compte et de toutes les données associées |
| **Droit à la limitation** (art. 18)     | Demander la suspension du traitement                                     |
| **Droit à la portabilité** (art. 20)    | Recevoir vos données dans un format structuré et lisible par machine (JSON) |
| **Droit d'opposition** (art. 21)        | Vous opposer à un traitement fondé sur l'intérêt légitime                |
| **Droit de retirer votre consentement** (art. 7.3) | Retirer à tout moment votre consentement (ex. déconnexion d'un service tiers) sans effet rétroactif |

### Comment exercer vos droits

- **Suppression du compte** : directement depuis l'Application, dans les paramètres (« Supprimer mon compte »). L'effacement est immédiat et irréversible.
- **Export de vos données** : depuis l'Application, fonction « Exporter mes données » (au format JSON).
- **Toute autre demande** : par email à <CONTACT_EMAIL>. Une réponse vous sera apportée dans un délai maximum d'**un mois** à compter de la réception (article 12.3 du RGPD).

> ⚠️ Compte tenu de l'architecture pseudonymisée de l'Application, l'éditeur **ne peut pas vous identifier à partir de votre seule adresse email**. Pour les demandes envoyées par email, il vous sera demandé de fournir votre identifiant interne (`userId`, visible dans les paramètres de l'Application) afin de procéder à l'opération.

### Réclamation auprès de l'autorité de contrôle

Si vous estimez, après nous avoir contactés, que vos droits ne sont pas respectés, vous pouvez introduire une réclamation auprès de la **Commission Nationale de l'Informatique et des Libertés (CNIL)** :

- En ligne : [https://www.cnil.fr/fr/plaintes](https://www.cnil.fr/fr/plaintes)
- Par courrier : 3 place de Fontenoy, TSA 80715, 75334 PARIS CEDEX 07

---

## 8. Sécurité

L'éditeur met en œuvre les mesures techniques et organisationnelles suivantes, conformément à l'article 32 du RGPD :

- **Chiffrement en transit** : toutes les communications entre l'Application et le serveur passent par HTTPS (TLS 1.2 minimum) avec certificat délivré par Let's Encrypt.
- **Chiffrement au repos** des secrets sensibles : jetons OAuth tiers chiffrés en base avec AES-256-GCM.
- **Pseudonymisation** : l'identifiant Google `sub` est haché avec une clé secrète serveur (HMAC-SHA-256) avant tout stockage.
- **Authentification forte** : authentification déléguée à Google (Google Sign-In), jetons internes signés cryptographiquement (RS256).
- **Principe du moindre privilège** : aucun service tiers n'accède à des données qui ne lui sont pas strictement nécessaires.
- **Journalisation sécurisée** : aucun identifiant utilisateur en clair dans les logs serveur ; rotation et purge automatique sous 30 jours.
- **Sauvegardes chiffrées** : sauvegardes quotidiennes de la base, chiffrées et conservées sur un support distinct.

En cas de **violation de données** susceptible d'engendrer un risque pour vos droits et libertés, l'éditeur s'engage à notifier la CNIL dans les 72 heures (article 33 du RGPD) et, le cas échéant, à vous en informer dans les meilleurs délais (article 34).

---

## 9. Cookies et traceurs

L'Application Android **ne dépose aucun cookie** ni traceur publicitaire ou analytique sur votre appareil. Aucun SDK tiers de mesure d'audience ou de publicité ciblée n'est intégré.

Les seuls identifiants techniques utilisés sont :
- les jetons d'authentification (stockés localement sur votre appareil) ;
- les jetons OAuth tiers (stockés chiffrés côté serveur).

---

## 10. Données des mineurs

L'Application n'est pas destinée à un public mineur de moins de **15 ans** (seuil de consentement numérique en France, article 8 du RGPD). L'éditeur ne collecte pas sciemment de données concernant des enfants de moins de 15 ans. Si vous constatez qu'un mineur a utilisé l'Application sans autorisation parentale, contactez <CONTACT_EMAIL> pour que les données soient supprimées.

---

## 11. Modifications de la politique

La présente politique peut être modifiée à tout moment pour refléter des évolutions techniques, légales ou fonctionnelles. La date de dernière mise à jour est indiquée en tête de document. Les modifications substantielles vous seront notifiées dans l'Application avant leur entrée en vigueur.

L'historique des versions est consultable publiquement à l'adresse <URL_REPO_PUBLIC>.

---

## 12. Contact

Pour toute question, demande d'exercice de droits ou réclamation :

- **Email** : <CONTACT_EMAIL>
- **Délai de réponse** : un mois maximum à compter de la réception

---

## Annexe — Tableau de correspondance « Sécurité des données » Google Play

| Type de données Google Play          | Collecté ? | Partagé ? | Optionnel ? | Finalité                          | Chiffré en transit | Suppressible |
| ------------------------------------ | ---------- | --------- | ----------- | --------------------------------- | ------------------ | ------------ |
| Nom                                  | ❌         | —         | —           | —                                 | —                  | —            |
| Adresse email                        | ❌ *(reçue mais immédiatement ignorée, jamais stockée)* | — | — | — | ✅ | — |
| Photo de profil                      | ❌         | —         | —           | —                                 | —                  | —            |
| Identifiant utilisateur (`sub` Google) | ✅ *(haché)* | ❌ | ❌ (requis) | Authentification                | ✅                 | ✅           |
| Identifiant utilisateur interne (UUID) | ✅       | ❌        | ❌ (requis) | Identification dans l'Application | ✅                 | ✅           |
| Données d'activité dans l'app (collections, items) | ✅ | ❌ | ❌ (cœur fonctionnel) | Stockage personnel | ✅ | ✅ |
| Achats dans l'app (token d'achat)    | ✅         | ❌        | ✅ (si premium souscrit) | Vérification abonnement | ✅                 | ✅           |
| Jetons OAuth tiers                   | ✅ *(chiffrés)* | ❌    | ✅ (si service connecté) | Appel API en votre nom | ✅          | ✅           |
| Informations financières             | ❌ *(gérées par Google Play uniquement)* | — | — | — | — | — |
| Localisation                         | ❌         | —         | —           | —                                 | —                  | —            |
| Contacts, calendrier, SMS, photos    | ❌         | —         | —           | —                                 | —                  | —            |
| Identifiants publicitaires           | ❌         | —         | —           | —                                 | —                  | —            |

**Méthodes de sécurité déclarées :**
- ✅ Les données sont chiffrées en transit
- ✅ Vous pouvez demander la suppression de vos données
- ✅ Les pratiques de sécurité ont été examinées en interne