import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 402 Payment Required — quota free tier dépassé. Permet au client de
 * différencier « upgrade pour continuer » d'un 403 « pas tes droits ».
 * Mappée sur `/probs/quota-exceeded` par `ProblemDetailsExceptionFilter`.
 */
export class QuotaExceededException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.PAYMENT_REQUIRED);
  }
}
