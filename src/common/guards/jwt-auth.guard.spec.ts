import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../../auth/auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

interface MockReq {
  headers: Record<string, string | undefined>;
  userId?: string;
}

function makeCtx(req: MockReq): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

function makeGuard(verifyImpl: (token: string) => { userId: string }) {
  const auth = { verifyJwt: jest.fn(verifyImpl) } as unknown as AuthService;
  return { guard: new JwtAuthGuard(auth), auth };
}

const USER_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

describe('JwtAuthGuard.canActivate', () => {
  it('throw Unauthorized quand le header Authorization est absent', () => {
    const { guard } = makeGuard(() => ({ userId: USER_ID }));
    const ctx = makeCtx({ headers: {} });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throw Unauthorized quand le préfixe n’est pas "Bearer "', () => {
    const { guard } = makeGuard(() => ({ userId: USER_ID }));
    const ctx = makeCtx({ headers: { authorization: 'Basic abcdef' } });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throw Unauthorized quand le token est vide (après "Bearer ")', () => {
    const { guard, auth } = makeGuard(() => ({ userId: USER_ID }));
    const ctx = makeCtx({ headers: { authorization: 'Bearer    ' } });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    expect(auth.verifyJwt).not.toHaveBeenCalled();
  });

  it('propage Unauthorized si AuthService.verifyJwt throw', () => {
    const { guard } = makeGuard(() => {
      throw new UnauthorizedException('Invalid or expired token');
    });
    const ctx = makeCtx({ headers: { authorization: 'Bearer bad.jwt' } });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('happy path : pose req.userId et retourne true', () => {
    const { guard } = makeGuard((tok) => {
      expect(tok).toBe('good.jwt');
      return { userId: USER_ID };
    });
    const req: MockReq = { headers: { authorization: 'Bearer good.jwt' } };
    const ctx = makeCtx(req);

    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.userId).toBe(USER_ID);
  });

  it('header sensible à la casse : "bearer " (minuscule) → 401', () => {
    const { guard } = makeGuard(() => ({ userId: USER_ID }));
    const ctx = makeCtx({ headers: { authorization: 'bearer good.jwt' } });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
