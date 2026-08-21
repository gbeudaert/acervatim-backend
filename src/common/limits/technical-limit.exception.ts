import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 409 Conflict — **plafond technique** atteint (S2).
 *
 * Ce n'est **pas** une limite de palier : il n'y a plus de palier gratuit depuis que la
 * synchronisation est premium-only, et payer davantage ne déplace pas ce plafond. C'est un
 * garde-fou anti-emballement (client en boucle, import qui dérape), identique pour tous les
 * comptes et non communiqué.
 *
 * D'où le 409 et non le 402 de `PaymentRequiredException` : répondre « Payment Required » ici
 * dirait à l'utilisateur de payer pour une limite que l'argent ne lève pas.
 *
 * Mappée sur `/probs/technical-limit` par `ProblemDetailsExceptionFilter`.
 */
export class TechnicalLimitException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.CONFLICT);
  }
}
