import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import {
  CollectionAccess,
  CollectionAccessService,
} from './collection-access.service';
import { resolveCollectionRef } from './collection-ref.resolve';
import { PaymentRequiredException } from './payment-required.exception';
import { PremiumService } from './premium.service';

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Posé par les guards de collection : évite au service de re-résoudre l'accès, et lui donne
     * la portée du partage (jamais fournie par le client).
     */
    collectionAccess?: CollectionAccess;
  }
}

/**
 * Gate premium **en lecture**, sur le statut du **propriétaire** de la collection.
 *
 * C'est toute la différence avec [PremiumGuard], qui regarde le requérant : appliqué tel quel en
 * lecture, il interdirait à un membre non-premium de consulter une collection qu'on lui partage —
 * ce qui viderait le chantier partage de son sens. Ici, ce qui compte est que **le propriétaire**
 * paie le stockage qu'on lit.
 *
 * Corollaire assumé (S4) : un propriétaire qui perd son premium **suspend** les partages qu'il a
 * émis — ses membres reçoivent 402, comme lui. Rien n'est supprimé ; le jour où il repaie, les
 * partages reprennent.
 *
 * À empiler APRÈS `JwtAuthGuard`, sur une route de lecture portant `@CollectionRef(...)`.
 */
@Injectable()
export class CollectionPremiumGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: CollectionAccessService,
    private readonly premium: PremiumService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const access = await resolveCollectionRef(
      this.reflector,
      this.access,
      ctx,
      'CollectionPremiumGuard',
    );
    if (!access) return true; // identifiant malformé : au pipe de rendre son 400
    const { isPremium } = await this.premium.getStatus(access.ownerUserId);
    if (!isPremium) {
      throw new PaymentRequiredException();
    }
    return true;
  }
}
