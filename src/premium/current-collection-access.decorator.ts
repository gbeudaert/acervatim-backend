import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { CollectionAccess } from './collection-access.service';

/**
 * Accès résolu par [CollectionPremiumGuard] pour la route courante : la collection visée, son
 * propriétaire, et la portée si le requérant est membre d'un partage.
 *
 * **Ne lève délibérément pas** quand la valeur est absente. Nest résout tous les paramètres d'un
 * handler en parallèle : une exception levée ici court-circuiterait le 400 de `ParseUUIDPipe` sur
 * un identifiant malformé — cas où le guard a justement laissé passer sans résoudre. Le handler,
 * lui, n'est appelé que si tous les pipes ont passé : l'identifiant était donc valide et le guard
 * a posé l'accès. La seule façon d'obtenir `undefined` ici est d'oublier le guard sur la route.
 */
export const CurrentCollectionAccess = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CollectionAccess =>
    ctx.switchToHttp().getRequest<Request>()
      .collectionAccess as CollectionAccess,
);
