import { ConflictException } from '@nestjs/common';

/**
 * 409 Conflict — l'invitation est valide mais `usedCount >= maxUses`.
 * Couvre aussi la race « place perdue entre check et increment ».
 */
export class InvitationExhaustedException extends ConflictException {
  constructor(message = 'Invitation épuisée') {
    super(message);
  }
}
