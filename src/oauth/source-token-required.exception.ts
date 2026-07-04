import { HttpException, HttpStatus } from '@nestjs/common';
import { OauthProvider } from './oauth.service';

/**
 * 403 — aucun jeton disponible pour une source externe : l'utilisateur n'a pas
 * connecté la source ET n'est pas premium (donc pas de repli Acervatim). Levée
 * par les adapters quand `TokenResolverService.resolve` renvoie `source: 'none'`
 * et que le mode dégradé (BnF + cache) n'a rien pu servir.
 *
 * Distincte du 402 `payment-required` : ici **deux** remédiations sont possibles
 * côté app — connecter la source (`/v1/oauth/:provider/start`) OU passer premium.
 * `provider` est exposé dans le payload (extension member RFC 9457) pour que
 * l'app route vers le bon parcours. Mappée sur `/probs/source-token-required`
 * par `ProblemDetailsExceptionFilter`.
 */
export class SourceTokenRequiredException extends HttpException {
  constructor(readonly provider: OauthProvider) {
    super(
      `No access token available for source "${provider}". Connect the source or upgrade to premium.`,
      HttpStatus.FORBIDDEN,
    );
  }
}
