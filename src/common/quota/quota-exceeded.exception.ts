import { ForbiddenException } from '@nestjs/common';

/**
 * Sous-classe sémantique de 403 — distincte des autres ForbiddenException pour
 * que `ProblemDetailsExceptionFilter` la mappe sur `/probs/quota-exceeded`.
 */
export class QuotaExceededException extends ForbiddenException {
  constructor(message: string) {
    super(message);
  }
}
