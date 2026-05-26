import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  IDENTITY_PROVIDERS,
  IdentityProvider,
} from './identity-provider.interface';

/**
 * Résout un `IdentityProvider` par son nom. Refuse les providers non enregistrés
 * (la liste est figée à l'init, pilotée par le module).
 */
@Injectable()
export class IdentityProviderRegistry {
  private readonly byName: ReadonlyMap<string, IdentityProvider>;

  constructor(@Inject(IDENTITY_PROVIDERS) providers: IdentityProvider[]) {
    const map = new Map<string, IdentityProvider>();
    for (const p of providers) {
      if (map.has(p.name)) {
        throw new Error(`Duplicate identity provider name: ${p.name}`);
      }
      map.set(p.name, p);
    }
    this.byName = map;
  }

  get(name: string): IdentityProvider {
    const p = this.byName.get(name);
    if (!p) {
      throw new UnauthorizedException(`Unknown identity provider: ${name}`);
    }
    return p;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }
}
