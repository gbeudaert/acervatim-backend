import { Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { AccessLogMiddleware } from './access-log.middleware';

function mockReqRes(
  reqOverrides: Partial<Request> = {},
  statusCode = 200,
): {
  req: Request;
  res: Response;
  headers: Record<string, unknown>;
  fireFinish: () => void;
} {
  const headers: Record<string, unknown> = {};
  const finishHandlers: Array<() => void> = [];
  const req = {
    method: 'GET',
    originalUrl: '/v1/x',
    headers: {},
    ...reqOverrides,
  } as unknown as Request;
  const res = {
    statusCode,
    setHeader: jest.fn((k: string, v: unknown) => {
      headers[k] = v;
    }),
    on: jest.fn((evt: string, cb: () => void) => {
      if (evt === 'finish') finishHandlers.push(cb);
      return res;
    }),
  } as unknown as Response;
  return {
    req,
    res,
    headers,
    fireFinish: () => finishHandlers.forEach((h) => h()),
  };
}

describe('AccessLogMiddleware', () => {
  it('genere un requestId si header absent et pose le header de reponse', () => {
    const mw = new AccessLogMiddleware();
    const { req, res, headers } = mockReqRes();
    const next = jest.fn();

    mw.use(req, res, next);

    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(headers['X-Request-Id']).toBe(req.requestId);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('reutilise un x-request-id entrant valide', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const mw = new AccessLogMiddleware();
    const { req, res } = mockReqRes({
      headers: { 'x-request-id': id },
    } as Partial<Request>);

    mw.use(req, res, jest.fn());

    expect(req.requestId).toBe(id);
  });

  it('ignore un x-request-id non UUID (anti log-injection) et en genere un', () => {
    const mw = new AccessLogMiddleware();
    const { req, res } = mockReqRes({
      headers: { 'x-request-id': 'not-a-uuid\n[INJECT]' },
    } as Partial<Request>);

    mw.use(req, res, jest.fn());

    expect(req.requestId).not.toBe('not-a-uuid\n[INJECT]');
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('loggue une ligne sur finish avec method/url/status/user', () => {
    const spy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const mw = new AccessLogMiddleware();
    const { req, res, fireFinish } = mockReqRes(
      {
        method: 'POST',
        originalUrl: '/v1/items',
        userId: 'user-123',
      } as Partial<Request>,
      201,
    );

    mw.use(req, res, jest.fn());
    fireFinish();

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toContain('POST /v1/items 201');
    expect(line).toContain('user=user-123');
    expect(line).toContain('req=');
    spy.mockRestore();
  });

  it('loggue user=- quand aucune authentification', () => {
    const spy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const mw = new AccessLogMiddleware();
    const { req, res, fireFinish } = mockReqRes({}, 401);

    mw.use(req, res, jest.fn());
    fireFinish();

    expect(spy.mock.calls[0][0] as string).toContain('user=-');
    spy.mockRestore();
  });
});
