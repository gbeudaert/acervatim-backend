import {
  ExecutionContext,
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Résolution commune aux guards de collection : lit `@CollectionRef`, remonte à la collection,
 * détermine le rôle du requérant et pose le résultat sur la requête pour que le service n'ait pas
 * à le recalculer.
 *
 * Retourne `null` quand l'identifiant est malformé : les guards passent AVANT les pipes, et un id
 * invalide doit rester le 400 de `ParseUUIDPipe`, pas devenir un 404.
 *
 * 404 (et non 403) quand il n'y a aucun accès : on ne confirme jamais l'existence d'une ressource
 * d'autrui. La distinction 403 est réservée à ce que le requérant peut déjà voir.
 */
export async function resolveCollectionRef(
  reflector: Reflector,
  accessService: CollectionAccessService,
  ctx: ExecutionContext,
  guardName: string,
): Promise<CollectionAccess | null> {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.userId) {
    throw new InternalServerErrorException(
      `${guardName} used without JwtAuthGuard`,
    );
  }
  const meta = reflector.get<CollectionRefMeta | undefined>(
    COLLECTION_REF_KEY,
    ctx.getHandler(),
  );
  if (!meta) {
    throw new InternalServerErrorException(
      `${guardName} used without @CollectionRef`,
    );
  }

  const raw = (req.params as Record<string, string>)[meta.param];
  if (!raw || !UUID_RE.test(raw)) return null;

  const collectionId = await accessService.resolveCollectionId(meta.via, raw);
  if (!collectionId) {
    throw new NotFoundException('Not found');
  }
  const access = await accessService.resolveAccess(req.userId, collectionId);
  if (!access) {
    throw new NotFoundException('Not found');
  }
  req.collectionAccess = access;
  return access;
}
