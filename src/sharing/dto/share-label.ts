import { z } from 'zod';

export const SHARE_LABEL_MAX = 200;

/**
 * Libellé libre d'un partage — côté propriétaire (« Wantlist manga avec Alice ») comme côté membre
 * (« Wantlist manga de Bob »). Aide-mémoire privé, jamais exposé à l'autre partie.
 *
 * Chaîne vide et blancs seuls valent `null` : « pas de libellé » a une seule représentation en base,
 * et un champ vidé dans l'UI efface au lieu de stocker `""`.
 *
 * C'est du texte saisi par un humain, et il nommera souvent quelqu'un. Il ne va donc **nulle part**
 * ailleurs que dans sa colonne : ni log, ni métadonnée d'audit, ni réponse destinée à l'autre partie.
 * Il sort en revanche dans l'export RGPD de son auteur — c'est sa donnée.
 */
export const shareLabel = () =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(SHARE_LABEL_MAX).nullable(),
  );
