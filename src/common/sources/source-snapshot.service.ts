import { Inject, Injectable } from '@nestjs/common';
import { SourceAdapter, UnifiedItem } from '../../oauth/providers/types';
import { SourceEntry, SourceRef } from '../../collections/types/common';

/** Token DI : tableau des adapters externes connus (1 par source). */
export const SOURCE_ADAPTERS = Symbol('SOURCE_ADAPTERS');

@Injectable()
export class SourceSnapshotService {
  private readonly byProvider: Map<string, SourceAdapter>;

  constructor(@Inject(SOURCE_ADAPTERS) adapters: SourceAdapter[]) {
    this.byProvider = new Map(adapters.map((a) => [a.source, a]));
  }

  hasAdapter(provider: string): boolean {
    return this.byProvider.has(provider);
  }

  /**
   * Construit une entrée `sources[]` pour `ref` :
   * - provider connu (adapter présent) → `fetchDetails` remplit `rawData` (le UnifiedItem normalisé) ;
   * - sinon → référence sans snapshot (`rawData`/`fetchedAt` à `null`).
   */
  async snapshot(ref: SourceRef, userId: string): Promise<SourceEntry> {
    const adapter = this.byProvider.get(ref.provider);
    if (!adapter) {
      return {
        provider: ref.provider,
        externalId: ref.externalId,
        rawData: null,
        fetchedAt: null,
      };
    }
    const unified: UnifiedItem = await adapter.fetchDetails(ref.externalId, {
      userId,
      limit: 1,
    });
    return {
      provider: ref.provider,
      externalId: ref.externalId,
      rawData: unified,
      fetchedAt: new Date().toISOString(),
    };
  }
}
