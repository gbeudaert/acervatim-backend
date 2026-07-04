import { Injectable } from '@nestjs/common';
import { PremiumService } from '../premium/premium.service';
import {
  DecryptedCredentials,
  OauthCredentialsService,
  OauthProvider,
} from './oauth.service';

/**
 * Décision de résolution d'un jeton pour une source externe, valable pour **tous**
 * les profils (cf. `docs/travail/etude-conformite-comptes.md` §3.1) :
 *  - `user`     : l'utilisateur a connecté la source → on utilise **ses** jetons.
 *  - `fallback` : pas de jeton user mais utilisateur premium → repli sur les jetons
 *                 Acervatim (l'adapter choisit la clé serveur propre à la source).
 *  - `none`     : ni jeton user ni premium → l'appelant sert le mode dégradé
 *                 (BnF + cache partagé) puis, à défaut, une erreur actionnable.
 */
export type TokenResolution =
  | { source: 'user'; credentials: DecryptedCredentials }
  | { source: 'fallback' }
  | { source: 'none' };

/**
 * Service central de résolution des jetons. La logique est unique et volontairement
 * indépendante du profil : seul le repli (`fallback`) est réservé au premium. Les
 * secrets serveur par source (MAL_CLIENT_ID, TMDB_API_KEY, consumer Discogs…) restent
 * portés par chaque adapter — ce service ne renvoie que la **décision**.
 */
@Injectable()
export class TokenResolverService {
  constructor(
    private readonly credentials: OauthCredentialsService,
    private readonly premium: PremiumService,
  ) {}

  async resolve(
    userId: string,
    provider: OauthProvider,
  ): Promise<TokenResolution> {
    const userCredentials = await this.credentials.get(userId, provider);
    if (userCredentials) {
      return { source: 'user', credentials: userCredentials };
    }

    const { isPremium } = await this.premium.getStatus(userId);
    if (isPremium) {
      return { source: 'fallback' };
    }

    return { source: 'none' };
  }
}
