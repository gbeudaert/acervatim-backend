import { paginate, PaginationQuerySchema } from './paginate';

interface Row {
  id: string;
  name: string;
}

const makeRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `row-${i + 1}`,
    name: `r${i + 1}`,
  }));

describe('paginate', () => {
  it('demande limit+1 au fetch pour détecter la page suivante', async () => {
    const captured: { take?: number; cursor?: string } = {};
    const fetch = jest.fn(async (take: number, cursor?: string) => {
      captured.take = take;
      captured.cursor = cursor;
      return makeRows(take); // simule "plus de pages disponibles"
    });

    await paginate(fetch, undefined, 25);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(captured.take).toBe(26);
    expect(captured.cursor).toBeUndefined();
  });

  it('renvoie nextCursor=null quand le fetch retourne moins que limit', async () => {
    const fetch = jest.fn(async () => makeRows(5));
    const page = await paginate(fetch, undefined, 25);

    expect(page.data).toHaveLength(5);
    expect(page.meta.pagination.nextCursor).toBeNull();
    expect(page.meta.pagination.limit).toBe(25);
  });

  it('renvoie nextCursor=null quand le fetch retourne exactement limit', async () => {
    const fetch = jest.fn(async (take: number) => makeRows(Math.min(take, 25)));
    const page = await paginate(fetch, undefined, 25);

    expect(page.data).toHaveLength(25);
    expect(page.meta.pagination.nextCursor).toBeNull();
  });

  it('renvoie nextCursor = id du dernier élément quand il reste des pages', async () => {
    const fetch = jest.fn(async (take: number) => makeRows(take));
    const page = await paginate(fetch, undefined, 25);

    expect(page.data).toHaveLength(25);
    expect(page.meta.pagination.nextCursor).toBe('row-25');
  });

  it('transmet le cursor reçu au fetch', async () => {
    const fetch = jest.fn(async () => makeRows(3));
    await paginate(fetch, 'row-25', 25);

    expect(fetch).toHaveBeenCalledWith(26, 'row-25');
  });
});

describe('PaginationQuerySchema', () => {
  it('défaut limit=50 quand absent', () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it('coerce limit depuis une string (query string)', () => {
    expect(PaginationQuerySchema.parse({ limit: '25' })).toEqual({ limit: 25 });
  });

  it('rejette limit > 100', () => {
    expect(() => PaginationQuerySchema.parse({ limit: '101' })).toThrow();
  });

  it('rejette limit < 1', () => {
    expect(() => PaginationQuerySchema.parse({ limit: '0' })).toThrow();
  });

  it('rejette un cursor non-UUID', () => {
    expect(() =>
      PaginationQuerySchema.parse({ cursor: 'not-a-uuid' }),
    ).toThrow();
  });

  it('accepte un cursor UUID v4', () => {
    const parsed = PaginationQuerySchema.parse({
      cursor: '7c4f3a18-9b8e-4a2f-9b3d-1f1a8e9b3d2c',
    });
    expect(parsed.cursor).toBe('7c4f3a18-9b8e-4a2f-9b3d-1f1a8e9b3d2c');
  });
});
