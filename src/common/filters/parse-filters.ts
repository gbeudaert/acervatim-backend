import { z } from 'zod';

const splitCsv = (raw: string): string[] =>
  raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

/**
 * Schéma Zod pour un filtre `field[in]=a,b,c`.
 *
 * Avec le parser qs par défaut d'Express, `?type[in]=vinyl,manga` arrive comme
 * `{ type: { in: 'vinyl,manga' } }`. Ce helper consomme cet objet `{ in: string }`,
 * valide chaque valeur contre la whitelist `values`, et renvoie `{ in: string[] }`
 * — directement utilisable comme valeur Prisma `where`.
 *
 * Usage : `type: filterIn(['vinyl', 'manga']).optional()`.
 */
export function filterIn<const T extends readonly [string, ...string[]]>(
  values: T,
) {
  return z
    .object({
      in: z
        .string()
        .transform(splitCsv)
        .pipe(z.array(z.enum(values)).min(1)),
    })
    .strict();
}

/**
 * Schéma Zod pour un filtre `field[all]=a,b`.
 *
 * Avec qs, `?tags[all]=jazz,blues` arrive comme `{ tags: { all: 'jazz,blues' } }`.
 * Ce helper produit `{ hasEvery: string[] }` — marqueur sémantique consommé par le
 * service appelant (MariaDB ne supporte pas `hasEvery` natif sur JSON, le service
 * traduit selon le modèle : jointure many-to-many, filtre applicatif, etc.).
 *
 * Usage : `tags: filterAll(['jazz', 'blues', 'rock']).optional()`.
 */
export function filterAll<const T extends readonly [string, ...string[]]>(
  values: T,
) {
  return z
    .object({
      all: z
        .string()
        .transform(splitCsv)
        .pipe(z.array(z.enum(values)).min(1)),
    })
    .strict()
    .transform(({ all }) => ({ hasEvery: all }));
}

/**
 * Valide `query` contre `schema` et renvoie l'objet typé prêt à splatter dans Prisma `where`.
 *
 * Le schéma doit être déclaré `.strict()` pour rejeter toute clé inconnue (sinon Zod
 * silencieusement les ignore, et un client peut sonder l'API sans erreur).
 */
export function parseFilters<S extends z.ZodTypeAny>(
  query: Record<string, unknown>,
  schema: S,
): z.infer<S> {
  return schema.parse(query);
}
