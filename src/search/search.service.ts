import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CollectionTypeCode } from '../collections/collection-type-codes';
import { CursorPage } from '../common/pagination/paginate';
import { BnfService } from '../common/sources/bnf/bnf.service';
import { EditionMapping, EditionTome } from '../common/sources/bnf/bnf.types';
import {
  CoverHint,
  CoverResult,
  GoogleBooksCoverService,
} from '../common/sources/googlebooks/googlebooks.service';
import { CoverStatus } from '../common/sources/googlebooks/googlebooks.types';
import { isSpecialArtEdition } from '../common/sources/manga-matching';
import { MangaDexCoverService } from '../common/sources/mangadex/mangadex.service';
import { MangaDexSeriesCovers } from '../common/sources/mangadex/mangadex.types';
import { SOURCE_ADAPTERS } from '../common/sources/source-snapshot.service';
import {
  AdapterSearchResult,
  SourceAdapter,
  UnifiedItem,
} from '../oauth/providers/types';

/** Critère de recherche : exactement un des deux est défini (garanti par le DTO). */
export interface SearchCriteria {
  q?: string;
  barcode?: string;
}

/**
 * Résolutions de jaquette Google Books menées de front pendant l'énumération d'édition.
 *
 * Volontairement bas : l'énumération d'une édition (30+ tomes) enfile autant de résolutions dans la
 * file `gbooks` (throttlée par un limiter global) ; un `Promise.all` non borné n'accélère rien (le
 * limiter sérialise le débit sortant) et ne ferait que gonfler le backlog Redis. Un petit palier
 * suffit à réchauffer le cache sans saturer la file ni les 503 Google en rafale.
 *
 * Historique : avant la passerelle BullMQ (P0), le débit `gbooks:global` passait par une unique ligne
 * SQL à CAS optimiste — sous un `Promise.all` large les writers se livelockaient et l'énumération
 * résolvait ZÉRO jaquette. Le bucket SQL a été supprimé ; le limiter de file le remplace, mais la
 * concurrence bornée reste la bonne hygiène côté producteur.
 */
const COVER_RESOLUTION_CONCURRENCY = 4;

/** Applique `fn` à `items` avec au plus `limit` exécutions concurrentes, en préservant l'ordre. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Tome d'édition + jaquette (Google Books, par ISBN). `coverUrl` est peuplé côté search — la BnF
 * n'en fournit pas — d'où ce type de réponse distinct qui laisse `EditionTome` (couche BnF) pur.
 *
 * `description` **surcharge** celle de `EditionTome` (330$a BnF) par un repli : BnF si présente,
 * sinon le résumé du volume Google Books déjà récupéré pour la jaquette (aucun appel de plus),
 * sinon `null` — on ne retombe jamais sur le résumé de série au niveau du tome.
 */
export interface EditionTomeWithCover extends EditionTome {
  coverUrl: string | null;
  /**
   * Issue de la résolution de jaquette (cf. {@link CoverStatus}) : `found` / `absent` (pas de jaquette,
   * définitif) / `unresolved` (transitoire — pas encore réchauffé ou 503, à re-tenter).
   * Permet à l'app de distinguer « pas de couverture » d'un « réessayer plus tard ».
   */
  coverStatus: CoverStatus;
  /**
   * Source de la jaquette retenue : `mangadex` (par série + n° de tome, prioritaire) ou
   * `google_books` (par ISBN, en repli), `null` si aucune. Purement informatif pour l'app/le debug.
   */
  coverSource: 'mangadex' | 'google_books' | null;
}

export interface EditionMappingResponse extends Omit<EditionMapping, 'tomes'> {
  tomes: EditionTomeWithCover[];
}

@Injectable()
export class SearchService {
  private readonly byMediaType: Map<CollectionTypeCode, SourceAdapter>;

  constructor(
    @Inject(SOURCE_ADAPTERS) adapters: SourceAdapter[],
    private readonly bnf: BnfService,
    private readonly googleBooks: GoogleBooksCoverService,
    private readonly mangaDex: MangaDexCoverService,
  ) {
    this.byMediaType = new Map(adapters.map((a) => [a.mediaType, a]));
  }

  /**
   * Énumère une édition manga complète (« toute la série d'un coup ») via la BnF, jaquette+résumé de
   * chaque tome lus en **cache-only** (Google Books) — **aucun appel réseau** dans le cycle
   * requête-réponse : l'endpoint HTTP répond en < 1 s même à froid. C'est la correction du timeout
   * client (incident 0.5.3 / 0.6.2 : le fan-out réseau de ~30 tomes dépassait les 10 s d'OkHttp).
   *
   * Un tome pas encore résolu ressort `coverUrl: null` sans jamais faire échouer l'énumération ; le
   * remplissage réel du cache est fait **hors requête** par le worker d'import via
   * {@link warmEditionMapping}. Le combo ISBN + hint BnF (titre série + n° de tome) qui retrouve la
   * notice illustrée vit donc côté worker (cf. `GoogleBooksCoverService.resolveCover`).
   */
  async editionMapping(
    titleFr: string,
    edition?: string,
    malId?: string,
  ): Promise<EditionMappingResponse> {
    return this.buildEditionMapping(titleFr, edition, {
      resolveCovers: false,
      malId,
    });
  }

  /**
   * Variante **réchauffage de cache** pour le worker d'import de série ({@link EditionImportProcessor}) :
   * résout réellement les jaquettes (file `gbooks` throttlée, best-effort) et remplit le cache que
   * {@link editionMapping} servira ensuite en < 1 s. `onProgress` alimente l'écran d'avancement de
   * l'app. NE PAS appeler depuis un handler HTTP : le fan-out réseau (30+ tomes) dépasse le timeout
   * client (incident 0.5.3 / 0.6.2) — c'est précisément pour ça que l'endpoint reste cache-only.
   */
  async warmEditionMapping(
    titleFr: string,
    edition?: string,
    onProgress?: (done: number, total: number) => void,
    malId?: string,
  ): Promise<EditionMappingResponse> {
    return this.buildEditionMapping(titleFr, edition, {
      resolveCovers: true,
      onProgress,
      malId,
    });
  }

  /**
   * Cœur partagé de l'énumération d'édition. `resolveCovers` bascule entre :
   *  - `false` (endpoint HTTP) — lecture **cache-only** des jaquettes/résumés, réponse rapide et sans
   *    réseau ; un tome pas encore résolu ressort `coverUrl: null` (réchauffé par le worker d'import) ;
   *  - `true` (worker d'import) — **résolution réelle** via la file `gbooks`, qui remplit le cache.
   */
  private async buildEditionMapping(
    titleFr: string,
    edition: string | undefined,
    opts: {
      resolveCovers: boolean;
      malId?: string;
      onProgress?: (done: number, total: number) => void;
    },
  ): Promise<EditionMappingResponse> {
    const mapping = await this.bnf.enumerateEdition(titleFr, edition ?? null);
    const total = mapping.tomes.length;

    // MangaDex, par SÉRIE : un seul appel pour toute l'édition (indexé par série + n° de tome), là où
    // Google Books coûte un appel par ISBN. Résolu réellement en réchauffage (worker), cache-only sur
    // l'endpoint HTTP. Le mal_id (fourni par le pivot) fiabilise le join ; sans lui, repli par titre.
    //
    // ⚠️ Garde-fou éditions d'art (plan §3) : MangaDex indexe par (n° de tome) SANS dimension édition.
    // Sur une édition d'art (Colossale/Perfect/Kanzenban… — visuel ET numérotation distincts), la
    // jaquette du tome N renverrait le VISUEL du standard (faux) → on saute MangaDex et on laisse la
    // cascade ISBN édition-consciente (Google Books). Les retirages (ordinaux) restent standard.
    const useMangaDex = !isSpecialArtEdition(mapping.edition);
    const md: MangaDexSeriesCovers = !useMangaDex
      ? { mangaId: null, volumes: {}, status: 'absent' }
      : opts.resolveCovers
        ? await this.mangaDex.resolveSeriesCovers(opts.malId ?? null, titleFr)
        : await this.mangaDex.cachedSeriesCovers(opts.malId ?? null, titleFr);

    let done = 0;
    const tomes = await mapWithConcurrency(
      mapping.tomes,
      COVER_RESOLUTION_CONCURRENCY,
      async (tome) => {
        // 1) Cascade jaquette : MangaDex (série + n° de tome) prioritaire. S'il l'a, on NE tape PAS
        // Google Books du tout (économie majeure de quota Google : ~80 % des tomes couverts ici).
        const mdCover = md.volumes[String(tome.editionVolume)];

        let coverUrl: string | null;
        let coverStatus: CoverStatus;
        let coverSource: 'mangadex' | 'google_books' | null;
        let description: string | null;

        if (mdCover) {
          coverUrl = mdCover.url;
          coverStatus = 'found';
          coverSource = 'mangadex';
          // MangaDex ne fournit pas de résumé → résumé par tome = 330$a BnF, sinon null.
          description = tome.description ?? null;
        } else {
          // 2) Repli Google Books par ISBN (jaquette + résumé). Cache-only sur l'endpoint HTTP.
          const gb: CoverResult = !tome.isbn
            ? { coverUrl: null, description: null, status: 'absent' }
            : opts.resolveCovers
              ? await this.googleBooks.resolveCoverAndDescription(tome.isbn, {
                  title: mapping.titleFr,
                  volume: tome.editionVolume,
                  edition: mapping.edition,
                })
              : await this.googleBooks.cachedCoverAndDescription(tome.isbn);
          coverUrl = gb.coverUrl;
          coverStatus = gb.status;
          coverSource = gb.coverUrl ? 'google_books' : null;
          // Résumé par tome : 330$a BnF prioritaire, sinon repli Google Books, sinon null.
          description = tome.description ?? gb.description;
        }

        // Avancement : incrément après chaque tome résolu (JS mono-thread → `done++`
        // entre deux `await` est sûr malgré la concurrence bornée). Sert au job d'import.
        done++;
        opts.onProgress?.(done, total);
        return {
          ...tome,
          coverUrl,
          coverStatus,
          coverSource,
          description,
        };
      },
    );
    return { ...mapping, tomes };
  }

  /**
   * Résout (réseau, best-effort) et met en cache la jaquette d'un tome par ISBN. Renvoie `null` si
   * aucune jaquette n'est trouvée ou en cas d'échec — jamais d'erreur propagée.
   *
   * `hint` (titre série + n° de tome + édition) est **optionnel mais fortement recommandé** : sans
   * lui, seule la résolution `isbn:` est tentée, or les ISBN papier FR (Ki-oon…) n'ont souvent aucune
   * jaquette chez Google Books → un `null` est alors mis en cache négatif pour plusieurs jours. Avec
   * le hint, le repli `intitle:<titre> T<n>` retrouve la notice illustrée du même tome.
   */
  async resolveCover(isbn: string, hint?: CoverHint): Promise<string | null> {
    return this.googleBooks.resolveCover(isbn, hint);
  }

  /**
   * Variante de {@link resolveCover} exposant le tri-état (cf. {@link CoverStatus}) pour l'endpoint
   * `/cover` : l'app distingue ainsi « pas de couverture » (`absent`, définitif) d'un « réessayer »
   * (`unresolved`, transitoire). L'URL reste `null` dans les deux cas hors `found`.
   */
  async resolveCoverDetailed(
    isbn: string,
    hint?: CoverHint,
  ): Promise<{ coverUrl: string | null; coverStatus: CoverStatus }> {
    const res = await this.googleBooks.resolveCoverAndDescription(isbn, hint);
    return { coverUrl: res.coverUrl, coverStatus: res.status };
  }

  async search(
    userId: string,
    type: CollectionTypeCode,
    criteria: SearchCriteria,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<UnifiedItem>> {
    const adapter = this.byMediaType.get(type);
    if (!adapter) {
      throw new BadRequestException(
        `search not supported for type '${type}' yet`,
      );
    }
    const ctx = { userId, cursor, limit };
    let res: AdapterSearchResult;
    if (criteria.barcode) {
      if (!adapter.searchByBarcode) {
        throw new BadRequestException(
          `barcode search not supported for type '${type}'`,
        );
      }
      res = await adapter.searchByBarcode(criteria.barcode, ctx);
    } else {
      res = await adapter.search(criteria.q ?? '', ctx);
    }
    return {
      data: res.items,
      meta: {
        pagination: {
          nextCursor: res.nextCursor,
          limit,
        },
      },
    };
  }
}
