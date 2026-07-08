import { ServiceUnavailableException } from '@nestjs/common';
import { Job } from 'bullmq';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { DiscogsProcessor } from './discogs.processor';
import { DiscogsFetchJobData } from './discogs.types';

function make(
  env: Record<string, string | undefined> = {
    DISCOGS_CONSUMER_KEY: 'ck',
    DISCOGS_CONSUMER_SECRET: 'cs',
  },
) {
  const config = {
    get: jest.fn((k: string) => env[k]),
  };
  const http = {
    request: jest
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, data: { ok: true } }),
  };
  const tokenResolver = { resolve: jest.fn() };
  const proc = new DiscogsProcessor(
    config as never,
    http as never,
    tokenResolver as never,
  );
  proc.onModuleInit();
  return { proc, http, tokenResolver };
}

const SEARCH_URL =
  'https://api.discogs.com/database/search?type=release&q=miles%20davis&per_page=50&page=1';

function job(url: string): Job<DiscogsFetchJobData, unknown> {
  return { data: { userId: 'u', url } } as Job<DiscogsFetchJobData, unknown>;
}

describe('DiscogsProcessor.process', () => {
  it('jeton user (BYOT) : signe OAuth 1.0a avec le token utilisateur (oauth_token présent)', async () => {
    const { proc, http, tokenResolver } = make();
    tokenResolver.resolve.mockResolvedValue({
      source: 'user',
      credentials: {
        accessToken: 'user-access',
        // Dans le schéma OAuth 1.0a, refreshToken porte le tokenSecret.
        refreshToken: 'user-secret',
        expiresAtMs: 0,
        scopes: [],
      },
    });

    const out = await proc.process(job(SEARCH_URL));

    expect(out).toEqual({ ok: true });
    const [url, opts] = http.request.mock.calls[0];
    // L'URL appelée est identique (query params préservés pour la signature).
    expect(url).toBe(SEARCH_URL);
    expect(opts.headers.Authorization).toMatch(/^OAuth /);
    expect(opts.headers.Authorization).toContain('oauth_consumer_key="ck"');
    expect(opts.headers.Authorization).toContain('oauth_token="user-access"');
    expect(opts.headers.Authorization).toContain('oauth_signature=');
  });

  it('repli premium avec DISCOGS_ACERVATIM_TOKEN : Authorization Discogs token= (images)', async () => {
    const { proc, http, tokenResolver } = make({
      DISCOGS_CONSUMER_KEY: 'ck',
      DISCOGS_CONSUMER_SECRET: 'cs',
      DISCOGS_ACERVATIM_TOKEN: 'perso-tok',
    });
    tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });

    await proc.process(job(SEARCH_URL));

    const [, opts] = http.request.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Discogs token=perso-tok');
  });

  it('repli premium sans personal token : signe en consumer-only (pas de oauth_token)', async () => {
    const { proc, http, tokenResolver } = make();
    tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });

    await proc.process(job(SEARCH_URL));

    const [, opts] = http.request.mock.calls[0];
    expect(opts.headers.Authorization).toMatch(/^OAuth /);
    expect(opts.headers.Authorization).toContain('oauth_consumer_key="ck"');
    expect(opts.headers.Authorization).not.toContain('oauth_token=');
  });

  it('dégradé (none) au moment de l’exécution → SourceTokenRequired, aucun appel', async () => {
    const { proc, http, tokenResolver } = make();
    tokenResolver.resolve.mockResolvedValue({ source: 'none' });

    await expect(proc.process(job(SEARCH_URL))).rejects.toBeInstanceOf(
      SourceTokenRequiredException,
    );
    expect(http.request).not.toHaveBeenCalled();
  });

  it('repli premium sans personal token NI consumer configuré → ServiceUnavailable, aucun appel', async () => {
    const { proc, http, tokenResolver } = make({});
    tokenResolver.resolve.mockResolvedValue({ source: 'fallback' });

    await expect(proc.process(job(SEARCH_URL))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(http.request).not.toHaveBeenCalled();
  });
});
