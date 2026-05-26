import { z } from 'zod';

export const PaginationQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export interface CursorPage<T> {
  data: T[];
  meta: { pagination: { nextCursor: string | null; limit: number } };
}

export async function paginate<T extends { id: string }>(
  fetch: (take: number, cursor?: string) => Promise<T[]>,
  cursor: string | undefined,
  limit: number,
): Promise<CursorPage<T>> {
  const rows = await fetch(limit + 1, cursor);
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    meta: {
      pagination: {
        nextCursor: hasMore ? data[data.length - 1].id : null,
        limit,
      },
    },
  };
}
