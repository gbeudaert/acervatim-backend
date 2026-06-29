import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { z, ZodError } from 'zod';
import { InvitationExhaustedException } from '../../invitations/invitation-exhausted.exception';
import { InvitationExpiredException } from '../../invitations/invitation-expired.exception';
import { PaymentRequiredException } from '../../premium/payment-required.exception';
import { QuotaExceededException } from '../quota/quota-exceeded.exception';
import {
  mapException,
  ProblemDetailsExceptionFilter,
} from './problem-details.filter';

interface MockRes {
  headers: Record<string, string>;
  statusCode?: number;
  body?: unknown;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    headers: {},
    setHeader(name, value) {
      res.headers[name] = value;
    },
    getHeader(name) {
      return res.headers[name];
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function makeHost(
  req: { url: string; requestId?: string },
  res: MockRes,
): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
}

describe('mapException', () => {
  it('mappe NotFoundException sur /probs/not-found 404', () => {
    expect(mapException(new NotFoundException())).toMatchObject({
      type: expect.stringContaining('/probs/not-found'),
      status: 404,
    });
  });

  it('mappe BadRequestException sur /probs/bad-request 400', () => {
    expect(mapException(new BadRequestException('x'))).toMatchObject({
      type: expect.stringContaining('/probs/bad-request'),
      status: 400,
    });
  });

  it('mappe QuotaExceededException sur /probs/quota-exceeded 402 (Payment Required)', () => {
    expect(mapException(new QuotaExceededException('max 10'))).toMatchObject({
      type: expect.stringContaining('/probs/quota-exceeded'),
      status: 402,
    });
  });

  it('mappe PaymentRequiredException sur /probs/payment-required 402 (distinct de quota-exceeded)', () => {
    expect(mapException(new PaymentRequiredException())).toMatchObject({
      type: expect.stringContaining('/probs/payment-required'),
      status: 402,
    });
  });

  it('mappe une ForbiddenException ordinaire sur /probs/forbidden 403', () => {
    expect(mapException(new ForbiddenException())).toMatchObject({
      type: expect.stringContaining('/probs/forbidden'),
      status: 403,
    });
  });

  it('mappe InvitationExpiredException sur /probs/invitation-expired 410', () => {
    expect(mapException(new InvitationExpiredException())).toMatchObject({
      type: expect.stringContaining('/probs/invitation-expired'),
      status: 410,
    });
  });

  it('mappe InvitationExhaustedException sur /probs/invitation-exhausted 409 (avant /probs/conflict)', () => {
    expect(mapException(new InvitationExhaustedException())).toMatchObject({
      type: expect.stringContaining('/probs/invitation-exhausted'),
      status: 409,
    });
  });

  it('mappe une erreur inconnue sur 500', () => {
    expect(mapException(new Error('boom'))).toMatchObject({
      type: expect.stringContaining('/probs/internal-server-error'),
      status: 500,
    });
  });
});

describe('ProblemDetailsExceptionFilter', () => {
  it('produit un payload Problem Details complet pour une NotFoundException', () => {
    const filter = new ProblemDetailsExceptionFilter();
    const res = makeRes();
    const host = makeHost({ url: '/v1/foo', requestId: 'req-123' }, res);

    filter.catch(new NotFoundException('Resource X missing'), host);

    expect(res.statusCode).toBe(404);
    expect(res.headers['Content-Type']).toBe('application/problem+json');
    expect(res.headers['X-Request-Id']).toBe('req-123');
    expect(res.body).toMatchObject({
      type: expect.stringContaining('/probs/not-found'),
      status: 404,
      instance: '/v1/foo',
      requestId: 'req-123',
    });
  });

  it('inclut errors[] pour une ZodValidationException', () => {
    const filter = new ProblemDetailsExceptionFilter();
    const res = makeRes();
    const host = makeHost({ url: '/v1/x', requestId: 'r1' }, res);

    const schema = z.object({ name: z.string().max(3) });
    const parsed = schema.safeParse({ name: 'too long' });
    if (parsed.success) throw new Error('expected zod failure for test');
    const exc = new ZodValidationException(parsed.error as ZodError);

    filter.catch(exc, host);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      type: expect.stringContaining('/probs/validation-error'),
      status: 400,
      errors: expect.arrayContaining([
        expect.objectContaining({ field: 'name', code: expect.any(String) }),
      ]),
    });
  });

  it('logge les erreurs 4xx en warn avec le resume des champs invalides', () => {
    const filter = new ProblemDetailsExceptionFilter();
    const warn = jest
      .spyOn(
        (filter as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation((_m: string) => undefined);
    const res = makeRes();
    const host = makeHost({ url: '/v1/x', requestId: 'r1' }, res);

    const schema = z.object({ coverUrl: z.string().url() });
    const parsed = schema.safeParse({ coverUrl: '' });
    if (parsed.success) throw new Error('expected zod failure for test');
    filter.catch(new ZodValidationException(parsed.error as ZodError), host);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('400');
    expect(warn.mock.calls[0][0]).toContain('coverUrl:invalid_string');
  });

  it('logge les erreurs 5xx en error avec la stack', () => {
    const filter = new ProblemDetailsExceptionFilter();
    const error = jest
      .spyOn(
        (filter as unknown as { logger: { error: (m: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation((_m: string) => undefined);
    const res = makeRes();
    const host = makeHost({ url: '/v1/boom', requestId: 'r2' }, res);

    filter.catch(new Error('boom'), host);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('500');
  });

  it("génère un requestId si l'interceptor n'a pas tourné", () => {
    const filter = new ProblemDetailsExceptionFilter();
    const res = makeRes();
    const host = makeHost({ url: '/v1/missing' }, res);

    filter.catch(new NotFoundException(), host);

    expect(typeof (res.body as { requestId: string }).requestId).toBe('string');
    expect(
      (res.body as { requestId: string }).requestId.length,
    ).toBeGreaterThan(0);
    expect(res.headers['X-Request-Id']).toBeDefined();
  });
});
