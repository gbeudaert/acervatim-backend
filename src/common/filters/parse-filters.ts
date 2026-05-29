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

const SEARCH_MAX_TERMS = 10;
const SEARCH_TERM_MAX_LEN = 100;

const searchTermsCsv = z
  .string()
  .transform(splitCsv)
  .pipe(
    z
      .array(z.string().min(1).max(SEARCH_TERM_MAX_LEN))
      .min(1)
      .max(SEARCH_MAX_TERMS),
  );

/**
 * Schéma Zod pour un filtre de recherche substring `field[in]=a,b` (OR) et/ou
 * `field[all]=a,b` (AND).
 *
 * Contrairement à `filterIn` (whitelist enum, égalité stricte), les valeurs sont
 * du **texte libre** matché en `contains` par le service appelant. Renvoie
 * `{ in?: string[]; all?: string[] }` — au moins l'un des deux est présent.
 *
 * Usage : `items: searchFilter().optional()`.
 */
export function searchFilter() {
  return z
    .object({
      in: searchTermsCsv.optional(),
      all: searchTermsCsv.optional(),
    })
    .strict()
    .refine((v) => v.in !== undefined || v.all !== undefined, {
      message: 'expected at least one of [in] or [all]',
    });
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
