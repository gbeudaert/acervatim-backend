import { Injectable, Logger } from '@nestjs/common';
import { HttpClientService } from '../../http/http-client.service';
import { BnfAuthor } from '../bnf/bnf.types';
import {
  matchesAuthor,
  normName,
  PIVOT_TITLE_STRONG,
  titleSimilarity,
} from '../manga-matching';
import {
  LOCALE_PREFERENCE,
  MangaDexIdentity,
  MangaDexSeriesCovers,
  MangaDexVolumeCover,
} from './mangadex.types';

const API_BASE = 'https://api.mangadex.org';
const UPLOADS_BASE = 'https://uploads.mangadex.org';

// Recherche de série : on ramène quelques candidats et on DÉSAMBIGUÏSE par mal_id (fiable). Sans
// mal_id (bnf_only), on n'accepte le 1er candidat que si son titre matche fortement (anti-homonyme).
const MANGA_SEARCH_LIMIT = 10;
const COVER_PAGE_SIZE = 100;
const COVER_MAX_RECORDS = 500; // garde-fou (séries à couvertures multi-éditions nombreuses).

// Similarité de titre minimale exigée quand l'auteur matche : évite de retenir une AUTRE œuvre du
// même mangaka (spin-off « Jigokuraku: … ») dont le titre diverge trop de la série scannée.
const IDENTIFY_TITLE_FLOOR = 0.5;

// ---- Sous-ensembles des réponses MangaDex réellement consommés ----
interface MangaListResponse {
  data?: MangaEntity[];
}
interface MangaEntity {
  id?: string;
  attributes?: {
    title?: Record<string, string>;
    altTitles?: Record<string, string>[];
    description?: Record<string, string>;
    links?: { mal?: string; al?: string };
    status?: string;
    year?: number | null;
    lastVolume?: string | null;
    contentRating?: string;
    tags?: {
      attributes?: { name?: Record<string, string>; group?: string };
    }[];
  };
  relationships?: {
    type?: string;
    attributes?: { name?: string; fileName?: string };
  }[];
}
interface StatisticsResponse {
  statistics?: Record<string, { rating?: { bayesian?: number } }>;
}
interface CoverListResponse {
  data?: {
    attributes?: { volume?: string | null; fileName?: string; locale?: string };
  }[];
}

/** Candidat scoré lors de l'identification (rapprochement titre + auteur). */
interface IdentifyCandidate {
  entity: MangaEntity;
  titleScore: number;
  authorMatched: boolean;
  confidence: number;
}

/**
 * Résolution **réseau** pure des couvertures MangaDex d'une série (sans cache ni throttle : portés
 * par {@link MangaDexCoverService} et le limiter du {@link MangaDexProcessor}). Deux étapes :
 *  1. trouver le manga (recherche par titre + désambiguïsation `links.mal`) ;
 *  2. récupérer ses couvertures et retenir, par n° de tome, la meilleure locale (fr > ja > en).
 *
 * Best-effort : un échec réseau/5xx **propage** (le worker le classe `unresolved` et retente) ; un
 * 2xx sans manga/jaquette exploitable ressort `absent` (définitif).
 */
@Injectable()
export class MangaDexResolver {
  private readonly logger = new Logger(MangaDexResolver.name);

  constructor(private readonly http: HttpClientService) {}

  /**
   * **Identifie** un manga (chemin nominal du scan, cf. plan §3). Recherche par titre (romaji ou FR)
   * + désambiguïsation titre/auteur (via `manga-matching`, mêmes règles que le pivot MAL), puis lit
   * l'identité complète : `links.mal`/`links.al`, synopsis multi-langue, méta, jaquette principale et
   * jaquettes par tome. Renvoie `null` si aucun candidat n'est validé (l'appelant replie sur MAL).
   *
   * Best-effort : un échec réseau/5xx **propage** (le worker le retente ; l'adapter replie sur MAL).
   */
  async identify(
    query: string,
    authors: BnfAuthor[],
  ): Promise<MangaDexIdentity | null> {
    const params = new URLSearchParams({
      title: query,
      limit: String(MANGA_SEARCH_LIMIT),
    });
    // includes[] → les relations author/artist/cover_art portent leurs `attributes` (nom, fileName).
    for (const inc of ['author', 'artist', 'cover_art']) {
      params.append('includes[]', inc);
    }
    const res = await this.http.request<MangaListResponse>(
      `${API_BASE}/manga?${params.toString()}`,
      { method: 'GET', maxAttempts: 2 },
    );
    const candidates = res.data?.data ?? [];

    const chosen = this.chooseIdentity(candidates, query, authors);
    if (!chosen) {
      this.logger.log(
        `mangadex: identify no match query="${query}" candidates=${candidates.length}`,
      );
      return null;
    }

    const { entity, titleScore, authorMatched, confidence } = chosen;
    const mangaId = entity.id!;
    const attrs = entity.attributes ?? {};

    const [volumes, rating] = await Promise.all([
      this.fetchVolumeCovers(mangaId),
      this.fetchRating(mangaId),
    ]);

    const titleFr =
      pickLang(attrs.title, 'fr') ?? pickAltLang(attrs.altTitles, 'fr');
    const titleRomaji =
      pickLang(attrs.title, 'ja-ro') ??
      pickAltLang(attrs.altTitles, 'ja-ro') ??
      pickLang(attrs.title, 'en') ??
      firstValue(attrs.title);
    const identity: MangaDexIdentity = {
      mangaId,
      title: titleFr ?? titleRomaji ?? query,
      titleFr,
      titleRomaji,
      descriptionFr: pickLang(attrs.description, 'fr'),
      descriptionEn: pickLang(attrs.description, 'en'),
      malId: attrs.links?.mal ? String(attrs.links.mal) : null,
      anilistId: attrs.links?.al ? String(attrs.links.al) : null,
      status: attrs.status ?? null,
      year: typeof attrs.year === 'number' ? attrs.year : null,
      lastVolume: attrs.lastVolume ?? null,
      contentRating: attrs.contentRating ?? null,
      genres: extractGenres(attrs.tags),
      authors: extractAuthors(entity.relationships),
      coverUrl: extractMainCover(mangaId, entity.relationships),
      rating,
      volumes,
      confidence,
      matchedBy: authorMatched ? 'title+author' : 'title',
    };

    this.logger.log(
      `mangadex: identified query="${query}" mangaId=${mangaId} mal=${identity.malId ?? '-'} ` +
        `titleSim=${titleScore.toFixed(2)} authorMatch=${authorMatched} conf=${confidence.toFixed(2)} ` +
        `tomes=${Object.keys(volumes).length} synopsisFr=${identity.descriptionFr ? 'y' : 'n'}`,
    );
    return identity;
  }

  /**
   * Choisit le meilleur candidat MangaDex pour l'identification. Score = titre (contenance/Dice, tous
   * titres + alt-titres) + match auteur + bonus égalité exacte de titre (départage les spin-offs du
   * même auteur, ex *Jigokuraku* qui remonte plusieurs entrées). Accepté si l'auteur matche ET que le
   * titre reste proche ({@link IDENTIFY_TITLE_FLOOR}), OU si le titre matche fortement seul (anti
   * faux-positif quand la BnF n'a pas d'auteur exploitable). Sinon `null`.
   */
  private chooseIdentity(
    candidates: MangaEntity[],
    query: string,
    authors: BnfAuthor[],
  ): IdentifyCandidate | null {
    let best: IdentifyCandidate | null = null;

    candidates.forEach((entity, rank) => {
      if (!entity.id) return;
      const titles = allTitles(entity.attributes);
      const titleScore = titles.reduce(
        (max, t) => Math.max(max, titleSimilarity(query, t)),
        0,
      );
      const exact = titles.some((t) => normName(t) === normName(query));
      const authorMatched = matchesAuthor(
        authors,
        extractAuthors(entity.relationships),
      );

      // Combinaison linéaire (max = 1.0) : titre 0.50, auteur 0.40, bonus exact 0.10.
      // Le rang MangaDex ne sert que de départage infinitésimal entre scores égaux.
      let confidence =
        0.5 * titleScore +
        0.4 * (authorMatched ? 1 : 0) +
        0.1 * (exact ? 1 : 0);
      confidence = Math.max(0, confidence - rank * 0.001);

      const cand: IdentifyCandidate = {
        entity,
        titleScore,
        authorMatched,
        confidence,
      };
      if (!best || cand.confidence > best.confidence) best = cand;
    });

    if (!best) return null;
    const b: IdentifyCandidate = best;
    const accepted = b.authorMatched
      ? b.titleScore >= IDENTIFY_TITLE_FLOOR
      : b.titleScore >= PIVOT_TITLE_STRONG;
    return accepted ? b : null;
  }

  /** Note bayésienne `/statistics/manga/{id}` — best-effort : `null` sur échec (jamais bloquant). */
  private async fetchRating(mangaId: string): Promise<number | null> {
    try {
      const res = await this.http.request<StatisticsResponse>(
        `${API_BASE}/statistics/manga/${mangaId}`,
        { method: 'GET', maxAttempts: 1 },
      );
      const r = res.data?.statistics?.[mangaId]?.rating?.bayesian;
      return typeof r === 'number' && r > 0 ? r : null;
    } catch {
      return null;
    }
  }

  async fetchSeriesCovers(
    title: string,
    malId: string | null,
  ): Promise<MangaDexSeriesCovers> {
    const mangaId = await this.findManga(title, malId);
    if (!mangaId) {
      this.logger.log(
        `mangadex: no manga match title="${title}" mal=${malId ?? '-'}`,
      );
      return { mangaId: null, volumes: {}, status: 'absent' };
    }

    const volumes = await this.fetchVolumeCovers(mangaId);
    const count = Object.keys(volumes).length;
    this.logger.log(
      `mangadex: series title="${title}" mal=${malId ?? '-'} mangaId=${mangaId} tomes=${count}`,
    );
    return {
      mangaId,
      volumes,
      status: count > 0 ? 'found' : 'absent',
    };
  }

  /**
   * Manga MangaDex correspondant. Avec `malId` : on retient le candidat dont `links.mal` égale le
   * mal_id (join exact). Sans `malId` : on ne retient le 1er candidat que si son titre (ou un alt.)
   * matche fortement la série voulue — sinon `null` (mieux vaut pas de jaquette qu'une mauvaise).
   */
  private async findManga(
    title: string,
    malId: string | null,
  ): Promise<string | null> {
    const params = new URLSearchParams({
      title,
      limit: String(MANGA_SEARCH_LIMIT),
    });
    const res = await this.http.request<MangaListResponse>(
      `${API_BASE}/manga?${params.toString()}`,
      { method: 'GET', maxAttempts: 2 },
    );
    const candidates = res.data?.data ?? [];

    if (malId) {
      const byMal = candidates.find(
        (m) => String(m.attributes?.links?.mal ?? '') === String(malId),
      );
      return byMal?.id ?? null;
    }

    const want = normalizeTitle(title);
    const top = candidates[0];
    if (top && titleMatchesStrongly(top, want)) return top.id ?? null;
    return null;
  }

  /** Récupère toutes les couvertures du manga (paginées) → map n° tome → meilleure locale. */
  private async fetchVolumeCovers(
    mangaId: string,
  ): Promise<Record<string, MangaDexVolumeCover>> {
    const byVolume = new Map<string, { fileName: string; locale: string }[]>();

    for (
      let offset = 0;
      offset < COVER_MAX_RECORDS;
      offset += COVER_PAGE_SIZE
    ) {
      const params = new URLSearchParams({
        'manga[]': mangaId,
        limit: String(COVER_PAGE_SIZE),
        offset: String(offset),
      });
      const res = await this.http.request<CoverListResponse>(
        `${API_BASE}/cover?${params.toString()}`,
        { method: 'GET', maxAttempts: 2 },
      );
      const page = res.data?.data ?? [];
      for (const doc of page) {
        const rawVol = doc.attributes?.volume;
        const fileName = doc.attributes?.fileName;
        if (rawVol == null || rawVol === '' || !fileName) continue;
        const n = Number(rawVol);
        if (!Number.isFinite(n)) continue; // "none", lettres… → ignoré
        const key = String(n);
        const list = byVolume.get(key) ?? [];
        list.push({ fileName, locale: doc.attributes?.locale ?? 'unknown' });
        byVolume.set(key, list);
      }
      if (page.length < COVER_PAGE_SIZE) break;
    }

    const out: Record<string, MangaDexVolumeCover> = {};
    for (const [volume, list] of byVolume) {
      const best = pickByLocale(list);
      out[volume] = {
        url: `${UPLOADS_BASE}/covers/${mangaId}/${best.fileName}.512.jpg`,
        locale: best.locale,
      };
    }
    return out;
  }
}

/** Retient la couverture de la locale la mieux classée (fr > ja > en > 1re disponible). */
function pickByLocale(list: { fileName: string; locale: string }[]): {
  fileName: string;
  locale: string;
} {
  for (const loc of LOCALE_PREFERENCE) {
    const hit = list.find((c) => c.locale === loc);
    if (hit) return hit;
  }
  return list[0];
}

/** Titre comparable : minuscules, sans accents ni ponctuation, espaces compactés. */
function normalizeTitle(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Match fort (sans mal_id) : le titre voulu et un des titres/alt-titres du candidat se contiennent
 * l'un l'autre une fois normalisés. Garde-fou anti-homonyme (« Kingdom Hearts » vs « Kingdom Hearts
 * III ») quand on n'a pas la clé mal_id pour désambiguïser.
 */
function titleMatchesStrongly(
  candidate: NonNullable<MangaListResponse['data']>[number],
  want: string,
): boolean {
  const titles = [
    ...Object.values(candidate.attributes?.title ?? {}),
    ...(candidate.attributes?.altTitles ?? []).flatMap((t) => Object.values(t)),
  ].map(normalizeTitle);
  return titles.some((t) => t === want);
}

/** Tous les libellés d'un manga (titre principal + alt-titres), toutes langues, pour le scoring. */
function allTitles(attrs: MangaEntity['attributes']): string[] {
  return [
    ...Object.values(attrs?.title ?? {}),
    ...(attrs?.altTitles ?? []).flatMap((t) => Object.values(t)),
  ].filter((s): s is string => !!s);
}

/** Valeur d'un `Record<langue, texte>` pour une langue donnée (`null` si absente). */
function pickLang(
  rec: Record<string, string> | undefined,
  lang: string,
): string | null {
  return rec?.[lang] ?? null;
}

/** Première valeur trouvée pour `lang` parmi une liste d'alt-titres (`null` si aucune). */
function pickAltLang(
  altTitles: Record<string, string>[] | undefined,
  lang: string,
): string | null {
  for (const t of altTitles ?? []) {
    if (t[lang]) return t[lang];
  }
  return null;
}

/** Première valeur d'un `Record` (ordre d'insertion), `null` si vide. */
function firstValue(rec: Record<string, string> | undefined): string | null {
  for (const v of Object.values(rec ?? {})) if (v) return v;
  return null;
}

/** Genres = tags de groupe `genre` (libellé EN préféré, sinon 1re langue). */
function extractGenres(
  tags: NonNullable<MangaEntity['attributes']>['tags'],
): string[] {
  const out: string[] = [];
  for (const tag of tags ?? []) {
    if (tag.attributes?.group !== 'genre') continue;
    const name = tag.attributes.name?.en ?? firstValue(tag.attributes.name);
    if (name) out.push(name);
  }
  return out;
}

/** Noms des relations `author`/`artist` (dédupliqués, ordre stable). */
function extractAuthors(rels: MangaEntity['relationships']): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rel of rels ?? []) {
    if (rel.type !== 'author' && rel.type !== 'artist') continue;
    const name = rel.attributes?.name?.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** URL de la jaquette principale (relation `cover_art`), `null` si absente. */
function extractMainCover(
  mangaId: string,
  rels: MangaEntity['relationships'],
): string | null {
  const cover = (rels ?? []).find(
    (r) => r.type === 'cover_art' && r.attributes?.fileName,
  );
  if (!cover?.attributes?.fileName) return null;
  return `${UPLOADS_BASE}/covers/${mangaId}/${cover.attributes.fileName}.512.jpg`;
}
