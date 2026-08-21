import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import {
  CollectionAccess,
  CollectionAccessService,
} from './collection-access.service';
import {
  COLLECTION_REF_KEY,
  CollectionRefMeta,
} from './collection-ref.decorator';
import { PaymentRequiredException } from './payment-required.exception';
import { PremiumService } from './premium.service';

declare module 'express-serve-static-core' {
  interface Request {
    /** Posé par [CollectionPremiumGuard] : évite au service de re-résoudre l'accès. */
    collectionAccess?: CollectionAccess;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Gate premium **en lecture**, sur le statut du **propriétaire** de la collection.
 *
 * C'est toute la différence avec [PremiumGuard], qui regarde le requérant : appliqué tel quel en
 * lecture, il interdirait à un membre non-premium de consulter une collection qu'on lui partage —
 * ce qui viderait le chantier partage de son sens. Ici, ce qui compte est que **le propriétaire**
 * paie le stockage qu'on lit.
 *
 * À ce sprint (S2) le requérant est forcément le propriétaire, le partage n'existant pas encore :
 * le guard est fonctionnellement équivalent à `PremiumGuard`. La forme owner-aware est posée
 * maintenant pour que S4 s'y branche en étendant `resolveAccess`, sans refonte des routes.
 *
 * À empiler APRÈS `JwtAuthGuard`, sur une route portant `@CollectionRef(...)`.
 */
@Injectable()
export class CollectionPremiumGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: CollectionAccessService,
    private readonly premium: PremiumService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.userId) {
      throw new InternalServerErrorException(
        'CollectionPremiumGuard used without JwtAuthGuard',
      );
    }
    const meta = this.reflector.get<CollectionRefMeta | undefined>(
      COLLECTION_REF_KEY,
      ctx.getHandler(),
    );
    if (!meta) {
      throw new InternalServerErrorException(
        'CollectionPremiumGuard used without @CollectionRef',
      );
    }

    const raw = (req.params as Record<string, string>)[meta.param];
    // Les guards passent AVANT les pipes : un identifiant malformé n'est pas notre affaire, on
    // laisse `ParseUUIDPipe` rendre son 400 plutôt que de le transformer en 404.
    if (!raw || !UUID_RE.test(raw)) return true;

    const collectionId = await this.access.resolveCollectionId(meta.via, raw);
    if (!collectionId) {
      throw new NotFoundException('Not found');
    }
    const access = await this.access.resolveAccess(req.userId, collectionId);
    if (!access) {
      throw new NotFoundException('Not found');
    }
    const { isPremium } = await this.premium.getStatus(access.ownerUserId);
    if (!isPremium) {
      throw new PaymentRequiredException();
    }
    // Évite au service de refaire la résolution, et donnera à S4 le `scope` déjà calculé.
    req.collectionAccess = access;
    return true;
  }
}
