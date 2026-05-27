import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { OAuthFlowProvider } from './providers/flow.types';

export const OAUTH_FLOW_PROVIDERS = Symbol('OAUTH_FLOW_PROVIDERS');

@Injectable()
export class OAuthFlowRegistry {
  private readonly byName: Map<string, OAuthFlowProvider>;

  constructor(@Inject(OAUTH_FLOW_PROVIDERS) providers: OAuthFlowProvider[]) {
    this.byName = new Map(providers.map((p) => [p.provider, p]));
  }

  /** 404 si le provider n'existe pas ou ne supporte pas le flux OAuth user (ex: TMDB). */
  get(provider: string): OAuthFlowProvider {
    const p = this.byName.get(provider);
    if (!p) {
      throw new NotFoundException(`oauth provider '${provider}' not supported`);
    }
    return p;
  }
}
