import { createHash } from 'crypto';
import {
  normalizeEdition,
  normalizePublisher,
  normalizeSeriesKey,
} from '../../common/sources/bnf/edition-records';

/**
 * Rattrapage serveur des séries en cours (SD3). Une fois par semaine, on demande à la BnF, pour
 * chaque édition suivie par au moins un abonné, quelles notices ont été **créées** depuis la
 * dernière vérification (`edition-mapping?since=`). Les tomes trouvés sont retenus par édition ;
 * `GET /v1/series-updates` en déduit, par série d'un utilisateur, ceux qu'il n'a pas encore.
 *
 * Cadence hebdomadaire et non quotidienne : la BnF crée la notice d'un tome 3 semaines à plusieurs
 * mois après sa sortie (étude du 2026-10-27, § 2) — un passage quotidien n'apporterait rien.
 */

/** File BullMQ du rattrapage : un seul job à la fois, toutes instances confondues. */
export const EDITION_WATCH_QUEUE = 'edition-watch';

/** Nom du job d'un passage complet (planifié ou déclenché à la main). */
export const EDITION_WATCH_RUN_JOB = 'run';

/** Id du planificateur BullMQ : `upsertJobScheduler` le rend idempotent au redémarrage. */
export const EDITION_WATCH_SCHEDULER_ID = 'edition-watch-weekly';

/** Lundi 04:00 (heure du serveur) : creux de trafic, et la file `bnf` est alors libre. */
export const EDITION_WATCH_CRON = '0 4 * * 1';

/**
 * Fenêtre du tout premier passage sur une édition : 60 jours couvrent le délai de catalogage
 * mesuré (+22 à +87 j) sans remonter toute l'histoire de la série — les tomes plus anciens sont
 * ceux que l'import a déjà créés, ou que l'utilisateur a écartés.
 */
export const FIRST_WINDOW_DAYS = 60;

/**
 * Recouvrement entre deux passages : une notice créée juste avant une vérification peut n'être
 * indexée par le SRU qu'après. Une semaine de marge absorbe ce délai et un passage manqué ; les
 * doublons sont écartés par n° de tome.
 */
export const OVERLAP_DAYS = 7;

/**
 * Durée de rétention d'un tome détecté. Au-delà, on cesse de le proposer : l'utilisateur qui ne
 * l'a pas ajouté en six mois l'a vraisemblablement écarté. Sert aussi de TTL à l'état d'une
 * édition, que chaque passage réécrit — une édition qui n'est plus suivie s'éteint seule.
 */
export const WATCH_RETENTION_DAYS = 180;
export const WATCH_TTL_SECONDS = WATCH_RETENTION_DAYS * 24 * 3600;

/** Taille des pages de nœuds lues pendant la sélection (borne la mémoire, pas le résultat). */
export const NODE_PAGE_SIZE = 500;

const DAY_MS = 24 * 3600 * 1000;

/** Ce qu'un nœud manga synchronisé dit de son édition (sous-ensemble de `MangaSerieSchema`). */
export interface WatchableNode {
  title: string;
  publisherFr: string;
  /** 205$a brut ; null = édition standard. */
  edition: string | null;
  mangaId: string | null;
  /** `MangaSerieSchema.status` (ongoing/finished/hiatus/unknown). */
  status: string | null;
}

/** Une édition à interroger, dédupliquée entre tous les nœuds qui la suivent. */
export interface WatchedEdition {
  key: string;
  title: string;
  publisherFr: string;
  edition: string | null;
  /** Premier `mangaId` connu parmi les nœuds : fiabilise les jaquettes servies en cache. */
  mangaId: string | null;
  /** Nombre de nœuds qui la suivent (log, priorisation éventuelle). */
  nodeCount: number;
}

/** Un tome découvert par le rattrapage. */
export interface WatchedTome {
  isbn: string | null;
  editionVolume: number;
  titleFr: string | null;
  /** Date de création de la notice BnF (`100$a`), `YYYY-MM-DD`. */
  noticeCreatedAt: string | null;
  coverUrl: string | null;
  /** Date (ISO) du passage qui l'a trouvé. */
  detectedAt: string;
}

/** État persisté d'une édition suivie (`ApiCacheService`, clé {@link editionWatchKey}). */
export interface EditionWatchState {
  title: string;
  publisherFr: string;
  edition: string | null;
  /**
   * Date (ISO) du dernier passage dont l'énumération a été lue **en entier** ; null tant qu'aucun
   * ne l'a été. Un passage incomplet ne l'avance pas : sa fenêtre n'est pas tenue pour vérifiée.
   */
  lastCheckedAt: string | null;
  /**
   * Borne `since` à rejouer telle quelle au prochain passage, posée quand le passage a été
   * incomplet (page SRU en échec, troncature) : on retente exactement la même fenêtre, y compris
   * au tout premier passage dont la fenêtre ne se déduit d'aucune vérification. Absent des états
   * écrits avant ce champ — équivaut à null.
   */
  retrySince?: string | null;
  tomes: WatchedTome[];
}

/** Bilan d'un passage complet. */
export interface EditionWatchRunResult {
  editions: number;
  checked: number;
  failed: number;
  /** Éditions vérifiées mais énumérées en partie : fenêtre à rejouer au prochain passage. */
  incomplete: number;
  newTomes: number;
}

/** Tome proposé à l'utilisateur par `GET /v1/series-updates`. */
export interface NewTome {
  isbn: string | null;
  editionVolume: number;
  titleFr: string | null;
  noticeCreatedAt: string | null;
  coverUrl: string | null;
}

/** Une série de l'utilisateur à laquelle il manque des tomes parus depuis. */
export interface SeriesUpdate {
  nodeId: string;
  title: string;
  edition: string | null;
  publisherFr: string;
  newTomes: NewTome[];
}

export interface SeriesUpdatesResponse {
  updates: SeriesUpdate[];
}

/**
 * Clé d'état d'une édition : titre, éditeur et mention normalisés — la même identité d'édition
 * que l'énumération (éditeur + 205$a), pour que « Pika éd. » et « Pika édition » partagent un état
 * et que Pika et France Loisirs n'en partagent jamais. Hashée : la clé brute porterait du texte libre.
 */
export function editionWatchKey(
  title: string,
  publisherFr: string,
  edition: string | null,
): string {
  const raw = [
    normalizeSeriesKey(title),
    normalizePublisher(publisherFr),
    normalizeEdition(edition),
  ].join('\u0000');
  return `edition-watch:v1:${createHash('sha1').update(raw).digest('hex')}`;
}

/** `Date` → `AAAAMMJJ` (UTC), seul format que `bib.creationdate` accepte sans renvoyer 0 en silence. */
export function toSruDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Borne `since` d'un passage : dernière vérification − {@link OVERLAP_DAYS} ; première fois :
 * maintenant − {@link FIRST_WINDOW_DAYS}. Une date de dernière vérification illisible est traitée
 * comme une première fois plutôt que de faire échouer le passage.
 */
export function sinceFor(lastCheckedAt: string | null, now: Date): string {
  const last = lastCheckedAt ? Date.parse(lastCheckedAt) : NaN;
  const from = Number.isFinite(last)
    ? last - OVERLAP_DAYS * DAY_MS
    : now.getTime() - FIRST_WINDOW_DAYS * DAY_MS;
  return toSruDate(new Date(from));
}

/**
 * Borne `since` du prochain passage sur une édition : la fenêtre restée en suspens après un passage
 * incomplet si elle existe, sinon celle déduite de la dernière vérification complète.
 */
export function nextSince(state: EditionWatchState | null, now: Date): string {
  return state?.retrySince ?? sinceFor(state?.lastCheckedAt ?? null, now);
}

/**
 * Lit l'édition d'un nœud manga. `null` si le nœud ne peut pas être suivi : sans titre ni éditeur,
 * on ne saurait pas quelle édition interroger (le titre seul ramènerait l'éditeur dominant, qui
 * n'est pas forcément celui de l'utilisateur).
 */
export function readWatchableNode(unifiedData: unknown): WatchableNode | null {
  if (!unifiedData || typeof unifiedData !== 'object') return null;
  const u = unifiedData as Record<string, unknown>;
  const text = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  const title = text(u.title);
  const publisherFr = text(u.publisherFr);
  if (!title || !publisherFr) return null;
  return {
    title,
    publisherFr,
    edition: text(u.edition),
    mangaId: text(u.mangaId),
    status: text(u.status),
  };
}

/**
 * Regroupe les nœuds suivables en éditions uniques. Une série terminée (`finished`) n'aura plus de
 * tome : inutile de payer une requête SRU par semaine pour elle.
 */
export function dedupeEditions(nodes: WatchableNode[]): WatchedEdition[] {
  const byKey = new Map<string, WatchedEdition>();
  for (const n of nodes) {
    if (n.status === 'finished') continue;
    const key = editionWatchKey(n.title, n.publisherFr, n.edition);
    const existing = byKey.get(key);
    if (existing) {
      existing.nodeCount++;
      existing.mangaId ??= n.mangaId;
      continue;
    }
    byKey.set(key, {
      key,
      title: n.title,
      publisherFr: n.publisherFr,
      edition: n.edition,
      mangaId: n.mangaId,
      nodeCount: 1,
    });
  }
  return [...byKey.values()];
}

/** Tome de l'énumération `since`, réduit à ce que le rattrapage conserve. */
export interface FoundTome {
  isbn: string | null;
  editionVolume: number;
  titleFr: string | null;
  noticeCreatedAt: string | null;
  coverUrl: string | null;
}

/**
 * Fusionne un passage dans l'état d'une édition : ajoute les tomes dont le n° n'était pas connu
 * (le recouvrement de fenêtres en ramène d'anciens), complète une jaquette apparue depuis, purge
 * les tomes détectés il y a plus de {@link WATCH_RETENTION_DAYS} jours. Renvoie aussi les ajouts,
 * pour le journal du délai.
 *
 * `window` dit ce que valait le passage : une énumération **incomplète** garde ses tomes (ils sont
 * réels) mais n'avance pas `lastCheckedAt` et mémorise sa borne `since` dans `retrySince` — le
 * passage suivant rejoue la même fenêtre au lieu de la croire vérifiée.
 */
export function mergeWatchState(
  previous: EditionWatchState | null,
  edition: Pick<WatchedEdition, 'title' | 'publisherFr' | 'edition'>,
  found: FoundTome[],
  now: Date,
  window: { since: string; complete: boolean },
): { state: EditionWatchState; added: WatchedTome[] } {
  const cutoff = now.getTime() - WATCH_RETENTION_DAYS * DAY_MS;
  const kept = (previous?.tomes ?? []).filter((t) => {
    const at = Date.parse(t.detectedAt);
    return Number.isFinite(at) && at >= cutoff;
  });
  const byVolume = new Map(kept.map((t) => [t.editionVolume, { ...t }]));
  const added: WatchedTome[] = [];
  const detectedAt = now.toISOString();

  for (const f of found) {
    const known = byVolume.get(f.editionVolume);
    if (known) {
      known.coverUrl ??= f.coverUrl;
      continue;
    }
    const tome: WatchedTome = { ...f, detectedAt };
    byVolume.set(f.editionVolume, tome);
    added.push(tome);
  }

  return {
    state: {
      title: edition.title,
      publisherFr: edition.publisherFr,
      edition: edition.edition,
      lastCheckedAt: window.complete
        ? detectedAt
        : (previous?.lastCheckedAt ?? null),
      retrySince: window.complete ? null : window.since,
      tomes: [...byVolume.values()].sort(
        (a, b) => a.editionVolume - b.editionVolume,
      ),
    },
    added,
  };
}

/**
 * Tomes d'une édition qu'un utilisateur n'a pas : comparaison par n° de tome, la seule identité
 * qu'un item synchronisé porte (son ISBN vit dans `unifiedData`, pas toujours renseigné).
 */
export function missingTomes(
  state: EditionWatchState | null,
  ownedVolumes: ReadonlySet<number>,
): NewTome[] {
  if (!state) return [];
  return state.tomes
    .filter((t) => !ownedVolumes.has(t.editionVolume))
    .map(({ isbn, editionVolume, titleFr, noticeCreatedAt, coverUrl }) => ({
      isbn,
      editionVolume,
      titleFr,
      noticeCreatedAt,
      coverUrl,
    }));
}
