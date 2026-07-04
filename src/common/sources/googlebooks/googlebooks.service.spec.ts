import { GoogleBooksCoverService } from './googlebooks.service';

function makeService(opts?: { apiKey?: string }) {
  const store = new Map<string, unknown>();
  const http = { request: jest.fn() };
  const cache = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
  };
  const bucket = { consume: jest.fn().mockResolvedValue(true) };
  const config = { get: jest.fn().mockReturnValue(opts?.apiKey) };
  const svc = new GoogleBooksCoverService(
    config as never,
    http as never,
    cache as never,
    bucket as never,
  );
  return { svc, http, cache, bucket, config, store };
}

function volumesResponse(imageLinks?: Record<string, string>) {
  return {
    status: 200,
    headers: {},
    data: { items: [{ volumeInfo: imageLinks ? { imageLinks } : {} }] },
  };
}

describe('GoogleBooksCoverService', () => {
  describe('resolveCover', () => {
    it('résout par ISBN, force https, retire edge=curl et met en cache (hit)', async () => {
      const { svc, http, cache } = makeService();
      http.request.mockResolvedValue(
        volumesResponse({
          thumbnail: 'http://books.google.com/books?id=x&edge=curl',
        }),
      );

      const url = await svc.resolveCover('978-2-505-01194-3');

      expect(url).toBe('https://books.google.com/books?id=x');
      // ISBN normalisé (sans tirets) dans la requête.
      expect(http.request.mock.calls[0][0]).toContain('q=isbn%3A9782505011943');
      expect(cache.set).toHaveBeenCalledWith(
        'gbooks:cover:9782505011943',
        { url: 'https://books.google.com/books?id=x' },
        expect.any(Number),
      );
    });

    it('utilise smallThumbnail en repli si pas de thumbnail', async () => {
      const { svc, http } = makeService();
      http.request.mockResolvedValue(
        volumesResponse({ smallThumbnail: 'https://img/s.jpg' }),
      );
      expect(await svc.resolveCover('9782505011943')).toBe('https://img/s.jpg');
    });

    it('met en cache négatif (url null) quand aucune image', async () => {
      const { svc, http, cache } = makeService();
      http.request.mockResolvedValue(volumesResponse());
      const url = await svc.resolveCover('9782505011943');
      expect(url).toBeNull();
      expect(cache.set).toHaveBeenCalledWith(
        'gbooks:cover:9782505011943',
        { url: null },
        expect.any(Number),
      );
    });

    it('court-circuite le réseau sur hit de cache', async () => {
      const { svc, http, store } = makeService();
      store.set('gbooks:cover:9782505011943', { url: 'https://c.jpg' });
      expect(await svc.resolveCover('9782505011943')).toBe('https://c.jpg');
      expect(http.request).not.toHaveBeenCalled();
    });

    it('renvoie null sans mettre en cache en cas d’échec réseau', async () => {
      const { svc, http, cache } = makeService();
      http.request.mockRejectedValue(new Error('boom'));
      expect(await svc.resolveCover('9782505011943')).toBeNull();
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('renvoie null quand rate limité, sans appel réseau', async () => {
      const { svc, http, bucket } = makeService();
      bucket.consume.mockResolvedValue(false);
      expect(await svc.resolveCover('9782505011943')).toBeNull();
      expect(http.request).not.toHaveBeenCalled();
    });

    it('renvoie null pour un ISBN trop court, sans réseau ni cache', async () => {
      const { svc, http, cache } = makeService();
      expect(await svc.resolveCover('123')).toBeNull();
      expect(http.request).not.toHaveBeenCalled();
      expect(cache.get).not.toHaveBeenCalled();
    });

    it('ajoute la clé API à la requête quand configurée', async () => {
      const { svc, http } = makeService({ apiKey: 'KEY123' });
      http.request.mockResolvedValue({
        status: 200,
        headers: {},
        data: { items: [] },
      });
      await svc.resolveCover('9782505011943');
      expect(http.request.mock.calls[0][0]).toContain('key=KEY123');
    });
  });

  describe('cachedCover', () => {
    it('lit le cache sans jamais appeler le réseau', async () => {
      const { svc, http, store } = makeService();
      store.set('gbooks:cover:9782505011943', { url: 'https://c.jpg' });
      expect(await svc.cachedCover('978-2-505-01194-3')).toBe('https://c.jpg');
      expect(http.request).not.toHaveBeenCalled();
    });

    it('renvoie null sur miss de cache', async () => {
      const { svc, http } = makeService();
      expect(await svc.cachedCover('9782505011943')).toBeNull();
      expect(http.request).not.toHaveBeenCalled();
    });
  });
});
