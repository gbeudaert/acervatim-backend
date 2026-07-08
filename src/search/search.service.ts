import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CollectionTypeCode } from '../collections/collection-type-codes';
import { CursorPage } from '../common/pagination/paginate';
import { BnfService } from '../common/sources/bnf/bnf.service';
import { EditionMapping, EditionTome } from '../common/sources/bnf/bnf.types';
import {
  CoverHint,
  GoogleBooksCoverService,
} from '../common/sources/googlebooks/googlebooks.service';
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
 * Volontairement bas, et pour une raison **interne** avant d'être une histoire de quota Google : le
 * bucket de débit `gbooks:global` est une unique ligne SQL à CAS optimiste (`TokenBucketService`).
 * Sous un `Promise.all` large (30+ tomes) tous les `consume` lisent le même `lastRefill` et se
 * disputent la même ligne — un seul writer gagne par tour, les autres réessaient puis abandonnent
 * (`token-bucket: CAS gave up`) et renvoient « rate limited » alors que le bucket est plein.
 * Résultat observé : `editionMapping` résolvait ZÉRO jaquette (le seul chemin portant le repli
 * `intitle:`), l'app retombait sur `/cover` sans repli → jaquettes manquantes. Les 503 Google en
 * rafale ne sont que l'effet secondaire une fois quelques appels passés.
 *
 * Gardé < `CAS_MAX_ATTEMPTS` pour que le writer le plus malchanceux gagne sa course avant d'épuiser
 * ses tentatives. Un petit palier suffit à fiabiliser le 1er passage sans ralentir l'énumération.
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
  ) {
    this.byMediaType = new Map(adapters.map((a) => [a.mediaType, a]));
  }

  /**
   * Énumère une édition manga complète (« toute la série d'un coup ») via la BnF, puis résout la
   * jaquette de chaque tome via Google Books (réseau, best-effort, en parallèle, mis en cache).
   *
   * La résolution combine ISBN **et** infos BnF : l'ISBN papier FR n'a souvent aucune jaquette chez
   * Google Books, mais le titre de série (`mapping.titleFr`) + le n° de tome (`editionVolume`)
   * retrouvent la notice illustrée du même tome (cf. `GoogleBooksCoverService.resolveCover`). Un
   * échec/absence dégrade en `coverUrl: null` sans jamais faire échouer l'énumération. Résultats
   * cachés : le 1er appel « à froid » est lent, les suivants repartent du cache.
   *
   * Concurrence **bornée** ({@link COVER_RESOLUTION_CONCURRENCY}) : résoudre les ~30 tomes en
   * parallèle total faisait livelocker le bucket `gbooks:global` (CAS optimiste sur une ligne
   * unique) → tous « rate limited », zéro jaquette résolue. Un petit pool lisse la charge sur le
   * bucket comme sur Google Books et fiabilise le 1er passage.
   */
  async editionMapping(
    titleFr: string,
    edition?: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<EditionMappingResponse> {
    const mapping = await this.bnf.enumerateEdition(titleFr, edition ?? null);
    const total = mapping.tomes.length;
    let done = 0;
    const tomes = await mapWithConcurrency(
      mapping.tomes,
      COVER_RESOLUTION_CONCURRENCY,
      async (tome) => {
        const resolved = tome.isbn
          ? await this.googleBooks.resolveCoverAndDescription(tome.isbn, {
              title: mapping.titleFr,
              volume: tome.editionVolume,
              edition: mapping.edition,
            })
          : { coverUrl: null, description: null };
        // Avancement : incrément après chaque tome résolu (JS mono-thread → `done++`
        // entre deux `await` est sûr malgré la concurrence bornée). Sert au job d'import.
        done++;
        onProgress?.(done, total);
        return {
          ...tome,
          coverUrl: resolved.coverUrl,
          // Résumé par tome : 330$a BnF prioritaire, sinon repli Google Books, sinon null.
          description: tome.description ?? resolved.description,
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
