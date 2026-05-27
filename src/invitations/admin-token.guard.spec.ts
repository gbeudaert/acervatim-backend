import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminTokenGuard } from './admin-token.guard';

const VALID_TOKEN = '0123456789abcdef-VALID-admin-token';

function makeGuardWithToken(token: string | undefined): AdminTokenGuard {
  const config = {
    get: jest.fn((k: string) => (k === 'ADMIN_API_TOKEN' ? token : undefined)),
  } as unknown as ConfigService;
  return new AdminTokenGuard(config);
}

function makeGuard(): AdminTokenGuard {
  return makeGuardWithToken(VALID_TOKEN);
}

function makeCtx(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: authorization === undefined ? {} : { authorization },
      }),
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

describe('AdminTokenGuard.constructor', () => {
  it('throw si ADMIN_API_TOKEN absent', () => {
    expect(() => makeGuardWithToken(undefined)).toThrow(/ADMIN_API_TOKEN/);
  });

  it('throw si ADMIN_API_TOKEN < 16 chars', () => {
    expect(() => makeGuardWithToken('short')).toThrow(/ADMIN_API_TOKEN/);
  });
});

describe('AdminTokenGuard.canActivate', () => {
  it('throw Unauthorized sans header Authorization', () => {
    const guard = makeGuard();
    expect(() => guard.canActivate(makeCtx())).toThrow(UnauthorizedException);
  });

  it('throw Unauthorized si pas le préfixe "Bearer "', () => {
    const guard = makeGuard();
    expect(() => guard.canActivate(makeCtx(`Basic ${VALID_TOKEN}`))).toThrow(
      UnauthorizedException,
    );
  });

  it('throw Unauthorized si la longueur du token diffère (court-circuit timing)', () => {
    const guard = makeGuard();
    // Longueur ≠ → court-circuit avant timingSafeEqual
    expect(() => guard.canActivate(makeCtx('Bearer x'))).toThrow(
      UnauthorizedException,
    );
  });

  it('throw Unauthorized si même longueur mais valeur différente (timing-safe)', () => {
    const guard = makeGuard();
    // Même longueur que VALID_TOKEN mais valeur différente — passe par timingSafeEqual
    const wrong = 'Z'.repeat(VALID_TOKEN.length);
    expect(() => guard.canActivate(makeCtx(`Bearer ${wrong}`))).toThrow(
      UnauthorizedException,
    );
  });

  it('happy path : Bearer + bon token → true', () => {
    const guard = makeGuard();
    expect(guard.canActivate(makeCtx(`Bearer ${VALID_TOKEN}`))).toBe(true);
  });
});
