import { ServiceUnavailableException } from '@nestjs/common';
import { Job } from 'bullmq';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { MalProcessor } from './mal.processor';
import { MalFetchJobData } from './mal.types';

function make(clientId: string | null = 'cid') {
  const config = {
    get: jest.fn((k: string) =>
      k === 'MAL_CLIENT_ID' ? (clientId ?? undefined) : undefined,
    ),
  };
  const http = {
    request: jest
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, data: { ok: true } }),
  };
  const tokenResolver = { resolve: jest.fn() };
  const proc = new MalProcessor(
    config as never,
    http as never,
    tokenResolver as never,
  );
  proc.onModuleInit();
  return { proc, http, tokenResolver };
}

function job(url: string): Job<MalFetchJobData, unknown> {
  return { data: { userId: 'u', url } } as Job<MalFetchJobData, unknown>;
}

const SEARCH_URL =
  'https://api.myanimelist.net/v2/manga?q=one%20piece&limit=50';

describe('MalProcessor.process', () => {
  it('jeton user (BYOT) : pose Authorization Bearer, pas de X-MAL-CLIENT-ID', async () => {
    const { proc, http, tokenResolver } = make('cid');
    tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: { accessToken: 'user-tok', expiresAtMs: 0, scopes: [] },
    });

    const out = await proc.process(job(SEARCH_URL));

    expect(out).toEqual({ ok: true });
    const [url, opts] = http.request.mock.calls[0];
    expect(url).toBe(SEARCH_URL);
    expect(opts.headers.Authorization).toBe('Bearer user-tok');
    expect(opts.headers['X-MAL-CLIENT-ID']).toBeUndefined();
  });

  it('repli premium (fallback) : pose X-MAL-CLIENT-ID serveur, pas de Bearer', async () => {
    const { proc, http, tokenResolver } = make('cid');
    tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });

    await proc.process(job(SEARCH_URL));

    const [, opts] = http.request.mock.calls[0];
    expect(opts.headers['X-MAL-CLIENT-ID']).toBe('cid');
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it('dégradé (none) au moment de l’exécution → SourceTokenRequired, aucun appel', async () => {
    const { proc, http, tokenResolver } = make('cid');
    tokenResolver.resolve.mockResolvedValue({ source: 'none' });

    await expect(proc.process(job(SEARCH_URL))).rejects.toBeInstanceOf(
      SourceTokenRequiredException,
    );
    expect(http.request).not.toHaveBeenCalled();
  });

  it('repli premium sans MAL_CLIENT_ID → ServiceUnavailable, aucun appel', async () => {
    const { proc, http, tokenResolver } = make(null);
    tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });

    await expect(proc.process(job(SEARCH_URL))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(http.request).not.toHaveBeenCalled();
  });
});
