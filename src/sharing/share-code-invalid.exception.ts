import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Code de partage inutilisable : inconnu, révoqué, expiré, épuisé, ou déjà révoqué pour ce membre.
 *
 * **Une seule exception pour ces cinq cas, volontairement.** Le message est actionnable (« ce code
 * ne permet plus de rejoindre »), mais ne dit pas *lequel* des cas s'applique : distinguer
 * « inconnu » de « révoqué » donnerait un oracle d'existence à qui balaie l'espace des codes, ce
 * que le rate-limit seul ne suffirait pas à contenir.
 *
 * 404 plutôt que 410/409 (le choix fait pour les invitations) pour la même raison : un statut
 * distinct par état *est* l'oracle qu'on refuse.
 */
export class ShareCodeInvalidException extends HttpException {
  constructor(
    message = 'Ce code de partage ne permet pas (ou plus) de rejoindre une collection',
  ) {
    super(message, HttpStatus.NOT_FOUND);
  }
}
