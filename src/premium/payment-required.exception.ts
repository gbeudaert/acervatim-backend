import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 402 Payment Required — endpoint protégé par `PremiumGuard` accédé par un user
 * non-premium. Distinct de `QuotaExceededException` (free tier dépassé) :
 *   - quota-exceeded : limite gratuite atteinte sur ressources créées.
 *   - payment-required : feature elle-même réservée premium.
 * Mappée sur `/probs/payment-required` par `ProblemDetailsExceptionFilter`.
 */
export class PaymentRequiredException extends HttpException {
  constructor(message = 'Premium subscription required') {
    super(message, HttpStatus.PAYMENT_REQUIRED);
  }
}
