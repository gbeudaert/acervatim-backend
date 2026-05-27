import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { CorrelationIdInterceptor } from './correlation-id.interceptor';

interface MockReq {
  headers: Record<string, string | undefined>;
  requestId?: string;
}
interface MockRes {
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
}

function makeContext(
  req: MockReq,
  res: MockRes,
): { ctx: ExecutionContext; next: CallHandler } {
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(null) };
  return { ctx, next };
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('CorrelationIdInterceptor', () => {
  let interceptor: CorrelationIdInterceptor;

  beforeEach(() => {
    interceptor = new CorrelationIdInterceptor();
  });

  it('génère un UUID v4 quand aucun header x-request-id', () => {
    const req: MockReq = { headers: {} };
    const res: MockRes = {
      headers: {},
      setHeader(n, v) {
        this.headers[n] = v;
      },
    };
    const { ctx, next } = makeContext(req, res);

    interceptor.intercept(ctx, next).subscribe();

    expect(req.requestId).toMatch(UUID_V4_RE);
    expect(res.headers['X-Request-Id']).toBe(req.requestId);
  });

  it('réutilise le header entrant s’il est un UUID valide', () => {
    const incoming = '11111111-2222-4333-8444-555555555555';
    const req: MockReq = { headers: { 'x-request-id': incoming } };
    const res: MockRes = {
      headers: {},
      setHeader(n, v) {
        this.headers[n] = v;
      },
    };
    const { ctx, next } = makeContext(req, res);

    interceptor.intercept(ctx, next).subscribe();

    expect(req.requestId).toBe(incoming);
  });

  it('régénère un UUID si l’entrée n’est pas un UUID (anti log-injection)', () => {
    const evil = '[31mFAKE-ERROR[0m; DROP TABLE logs;--';
    const req: MockReq = { headers: { 'x-request-id': evil } };
    const res: MockRes = {
      headers: {},
      setHeader(n, v) {
        this.headers[n] = v;
      },
    };
    const { ctx, next } = makeContext(req, res);

    interceptor.intercept(ctx, next).subscribe();

    expect(req.requestId).not.toBe(evil);
    expect(req.requestId).toMatch(UUID_V4_RE);
  });

  it('régénère sur header vide', () => {
    const req: MockReq = { headers: { 'x-request-id': '' } };
    const res: MockRes = {
      headers: {},
      setHeader(n, v) {
        this.headers[n] = v;
      },
    };
    const { ctx, next } = makeContext(req, res);

    interceptor.intercept(ctx, next).subscribe();

    expect(req.requestId).toMatch(UUID_V4_RE);
  });

  it('régénère sur une valeur trop courte', () => {
    const req: MockReq = { headers: { 'x-request-id': 'short' } };
    const res: MockRes = {
      headers: {},
      setHeader(n, v) {
        this.headers[n] = v;
      },
    };
    const { ctx, next } = makeContext(req, res);

    interceptor.intercept(ctx, next).subscribe();

    expect(req.requestId).toMatch(UUID_V4_RE);
  });
});
