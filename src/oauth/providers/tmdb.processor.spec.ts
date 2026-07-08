import { ServiceUnavailableException } from '@nestjs/common';
import { Job } from 'bullmq';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TmdbProcessor } from './tmdb.processor';
import { TmdbFetchJobData } from './tmdb.types';

function make(serverKey: string | null = 'server-key') {
  const config = {
    get: jest.fn((k: string) =>
      k === 'TMDB_API_KEY' ? (serverKey ?? undefined) : undefined,
    ),
  };
  const http = {
    request: jest
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, data: { ok: true } }),
  };
  const tokenResolver = { resolve: jest.fn() };
  const proc = new TmdbProcessor(
    config as never,
    http as never,
    tokenResolver as never,
  );
  proc.onModuleInit();
  return { proc, http, tokenResolver };
}

function job(url: string): Job<TmdbFetchJobData, unknown> {
  return { data: { userId: 'u', url } } as Job<TmdbFetchJobData, unknown>;
}

const SEARCH_URL = 'https://api.themoviedb.org/3/search/movie?query=x&page=1';

describe('TmdbProcessor.process', () => {
  it('repli premium : injecte la clé serveur et renvoie les données', async () => {
    const { proc, http, tokenResolver } = make('server-key');
    tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });

    const out = await proc.process(job(SEARCH_URL));

    expect(out).toEqual({ ok: true });
    const url = http.request.mock.calls[0][0] as string;
    expect(url).toContain('api_key=server-key');
    expect(url.startsWith(SEARCH_URL)).toBe(true);
    // URL déjà avec `?` → la clé est ajoutée en `&`.
    expect(url).toContain('&api_key=');
  });

  it('clé perso user (BYOT) : injecte la clé de l’utilisateur', async () => {
    const { proc, http, tokenResolver } = make('server-key');
    tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: { accessToken: 'user-key', expiresAtMs: 0, scopes: [] },
    });

    await proc.process(job(SEARCH_URL));

    expect(http.request.mock.calls[0][0]).toContain('api_key=user-key');
  });

  it('dégradé (none) au moment de l’exécution → SourceTokenRequired', async () => {
    const { proc, http, tokenResolver } = make('server-key');
    tokenResolver.resolve.mockResolvedValue({ source: 'none' });

    await expect(proc.process(job(SEARCH_URL))).rejects.toBeInstanceOf(
      SourceTokenRequiredException,
    );
    expect(http.request).not.toHaveBeenCalled();
  });

  it('repli premium sans clé serveur → ServiceUnavailable', async () => {
    const { proc, http, tokenResolver } = make(null);
    tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });

    await expect(proc.process(job(SEARCH_URL))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(http.request).not.toHaveBeenCalled();
  });
});
