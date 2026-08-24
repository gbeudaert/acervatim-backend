import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CollectionAccessService } from './collection-access.service';
import { resolveCollectionRef } from './collection-ref.resolve';
import { PaymentRequiredException } from './payment-required.exception';
import { PremiumService } from './premium.service';

/**
 * Gate d'**écriture** sur une collection : seul le propriétaire mute, et il doit être premium.
 *
 * C'est ici que la lecture seule d'un partage est garantie — au niveau guard, avant tout service,
 * et donc indépendamment de ce que l'UI de l'app décide d'afficher. Trois issues :
 *
 * | Requérant | Réponse |
 * |---|---|
 * | Aucun accès | 404 — on ne confirme pas l'existence d'une ressource d'autrui |
 * | Membre d'un partage | **403** — il *voit* déjà la ressource ; un 404 mentirait sur ce qu'il lit |
 * | Propriétaire non premium | 402 |
 *
 * Remplace [PremiumGuard] sur les routes de mutation qui visent une collection identifiable. Les
 * routes sans `@CollectionRef` (création de collection, gestion des partages) gardent `PremiumGuard`.
 */
@Injectable()
export class CollectionWriteGuard implements CanActivate {
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
      'CollectionWriteGuard',
    );
    if (!access) return true; // identifiant malformé : au pipe de rendre son 400
    if (access.role !== 'owner') {
      throw new ForbiddenException('Collection partagée en lecture seule');
    }
    const { isPremium } = await this.premium.getStatus(access.ownerUserId);
    if (!isPremium) {
      throw new PaymentRequiredException();
    }
    return true;
  }
}
