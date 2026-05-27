import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClientService } from './http-client.service';

const USER_AGENT = 'Acervatim-Backend/1.0 (+test@local)';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeService(): HttpClientService {
  const config = {
    get: jest.fn((key: string) =>
      key === 'HTTP_USER_AGENT' ? USER_AGENT : undefined,
    ),
  } as unknown as ConfigService;
  const svc = new HttpClientService(config);
  svc.onModuleInit();
  return svc;
}

describe('HttpClientService', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    // Empêche `setTimeout` du backoff de réellement attendre.
    jest.spyOn(global, 'setTimeout').mockImplementation((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    });
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('réussit dès la 1ère tentative et injecte le User-Agent', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    const svc = makeService();

    const res = await svc.request<{ ok: boolean }>('https://api/x');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers['User-Agent']).toBe(USER_AGENT);
  });

  it('503 deux fois puis 200 → 3 tentatives, succès', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { err: 'down' }))
      .mockResolvedValueOnce(jsonResponse(503, { err: 'down' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const svc = makeService();

    const res = await svc.request('https://api/x');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('500 trois fois → throw BadGatewayException (mappé /probs/upstream-unavailable)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { err: 'boom' }));
    const svc = makeService();

    await expect(svc.request('https://api/x')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('400 → throw immédiat, pas de retry', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { err: 'bad' }));
    const svc = makeService();

    await expect(svc.request('https://api/x')).rejects.toThrow(
      '400 client error',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 → retry (avec Retry-After respecté), passe au call suivant', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '1' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const svc = makeService();

    const res = await svc.request('https://api/x');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('erreur réseau (fetch reject) → retry, puis BadGateway après MAX_ATTEMPTS', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const svc = makeService();

    await expect(svc.request('https://api/x')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("timeout wiring : un AbortSignal est passé à fetch et l'override timeoutMs est respecté", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    const svc = makeService();

    await svc.request('https://api/x', { timeoutMs: 50 });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throw au boot si HTTP_USER_AGENT n'est pas configuré", () => {
    const config = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    const svc = new HttpClientService(config);
    expect(() => svc.onModuleInit()).toThrow('HTTP_USER_AGENT must be set');
  });
});
