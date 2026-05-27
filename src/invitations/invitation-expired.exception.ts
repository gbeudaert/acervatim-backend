import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 410 Gone — l'invitation a existé mais sa fenêtre d'usage est dépassée.
 * Permet au client de différencier `expired` d'un 403 « pas tes droits ».
 */
export class InvitationExpiredException extends HttpException {
  constructor(message = 'Invitation expirée') {
    super(message, HttpStatus.GONE);
  }
}
