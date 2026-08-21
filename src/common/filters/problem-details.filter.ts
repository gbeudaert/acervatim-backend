import {
  ArgumentsHost,
  BadGatewayException,
  BadRequestException,
  Catch,
  ConflictException,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { ZodIssue } from 'zod';
import { InvitationExhaustedException } from '../../invitations/invitation-exhausted.exception';
import { InvitationExpiredException } from '../../invitations/invitation-expired.exception';
import { SourceTokenRequiredException } from '../../oauth/source-token-required.exception';
import { PaymentRequiredException } from '../../premium/payment-required.exception';
import { TechnicalLimitException } from '../limits/technical-limit.exception';

const TYPE_BASE = 'https://api.acervatim/probs';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  requestId: string;
  errors?: Array<{ field: string; code: string; message: string }>;
  /** Extension member : source concernée par un `source-token-required`. */
  provider?: string;
}

interface Mapped {
  type: string;
  title: string;
  status: number;
}

export function mapException(exception: unknown): Mapped {
  if (exception instanceof ZodValidationException) {
    return {
      type: `${TYPE_BASE}/validation-error`,
      title: 'Invalid request payload',
      status: 400,
    };
  }
  if (exception instanceof BadRequestException) {
    return {
      type: `${TYPE_BASE}/bad-request`,
      title: 'Bad request',
      status: 400,
    };
  }
  if (exception instanceof UnauthorizedException) {
    return {
      type: `${TYPE_BASE}/unauthorized`,
      title: 'Unauthorized',
      status: 401,
    };
  }
  if (exception instanceof TechnicalLimitException) {
    return {
      type: `${TYPE_BASE}/technical-limit`,
      title: 'Technical limit reached',
      status: 409,
    };
  }
  if (exception instanceof PaymentRequiredException) {
    return {
      type: `${TYPE_BASE}/payment-required`,
      title: 'Payment required',
      status: 402,
    };
  }
  if (exception instanceof SourceTokenRequiredException) {
    return {
      type: `${TYPE_BASE}/source-token-required`,
      title: 'Source token required',
      status: 403,
    };
  }
  if (exception instanceof ForbiddenException) {
    return { type: `${TYPE_BASE}/forbidden`, title: 'Forbidden', status: 403 };
  }
  if (exception instanceof NotFoundException) {
    return { type: `${TYPE_BASE}/not-found`, title: 'Not found', status: 404 };
  }
  if (exception instanceof InvitationExpiredException) {
    return {
      type: `${TYPE_BASE}/invitation-expired`,
      title: 'Invitation expired',
      status: 410,
    };
  }
  if (exception instanceof InvitationExhaustedException) {
    return {
      type: `${TYPE_BASE}/invitation-exhausted`,
      title: 'Invitation exhausted',
      status: 409,
    };
  }
  if (exception instanceof ConflictException) {
    return { type: `${TYPE_BASE}/conflict`, title: 'Conflict', status: 409 };
  }
  if (exception instanceof BadGatewayException) {
    return {
      type: `${TYPE_BASE}/upstream-unavailable`,
      title: 'Upstream unavailable',
      status: 502,
    };
  }
  if (exception instanceof HttpException) {
    return mapStatus(exception.getStatus());
  }
  const exposed = getExposedStatus(exception);
  if (exposed !== undefined) {
    return mapStatus(exposed);
  }
  return {
    type: `${TYPE_BASE}/internal-server-error`,
    title: 'Internal server error',
    status: 500,
  };
}

function mapStatus(status: number): Mapped {
  if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
    return {
      type: `${TYPE_BASE}/payload-too-large`,
      title: 'Payload too large',
      status,
    };
  }
  if (status === HttpStatus.TOO_MANY_REQUESTS) {
    return {
      type: `${TYPE_BASE}/too-many-requests`,
      title: 'Too many requests',
      status,
    };
  }
  return { type: `${TYPE_BASE}/http-error`, title: 'HTTP error', status };
}

/** Reconnaît les erreurs Express body-parser : { status: 413, expose: true, ... }. */
function getExposedStatus(exception: unknown): number | undefined {
  if (!exception || typeof exception !== 'object') return undefined;
  const e = exception as {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
  };
  if (e.expose !== true) return undefined;
  const s =
    typeof e.status === 'number'
      ? e.status
      : typeof e.statusCode === 'number'
        ? e.statusCode
        : undefined;
  return s && s >= 400 && s < 600 ? s : undefined;
}

function extractDetail(exception: unknown, fallback: string): string {
  if (exception instanceof HttpException) {
    const res = exception.getResponse();
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object') {
      const msg = (res as { message?: unknown }).message;
      if (typeof msg === 'string') return msg;
      if (Array.isArray(msg)) return msg.join('; ');
    }
    return exception.message || fallback;
  }
  if (exception instanceof Error && exception.message) return exception.message;
  return fallback;
}

function zodIssuesToErrors(issues: readonly ZodIssue[]) {
  return issues.map((i) => ({
    field: i.path.map(String).join('.'),
    code: i.code,
    message: i.message,
  }));
}

@Catch()
export class ProblemDetailsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const mapped = mapException(exception);
    const requestId = req.requestId ?? randomUUID();
    if (!res.getHeader('X-Request-Id')) {
      res.setHeader('X-Request-Id', requestId);
    }

    const body: ProblemDetails = {
      type: mapped.type,
      title: mapped.title,
      status: mapped.status,
      detail: extractDetail(exception, mapped.title),
      instance: req.originalUrl ?? req.url ?? '',
      requestId,
    };

    if (exception instanceof ZodValidationException) {
      const zodError = exception.getZodError();
      body.errors = zodIssuesToErrors(zodError.issues);
    }

    if (exception instanceof SourceTokenRequiredException) {
      body.provider = exception.provider;
    }

    // Log de toutes les erreurs HTTP renvoyees : 5xx en `error` (avec stack),
    // 4xx en `warn`. Privacy by design : on logge le statut, le titre, le detail
    // et le resume des champs invalides (nom + code Zod), jamais les valeurs du
    // body ni les headers.
    if (mapped.status >= 500) {
      const stack =
        exception instanceof Error ? exception.stack : String(exception);
      this.logger.error(
        `[${requestId}] ${mapped.status} ${mapped.title}: ${body.detail}`,
        stack,
      );
    } else if (mapped.status >= 400) {
      const fields = body.errors?.length
        ? ` fields=[${body.errors
            .map((e) => `${e.field}:${e.code}`)
            .join(', ')}]`
        : '';
      this.logger.warn(
        `[${requestId}] ${mapped.status} ${mapped.title}: ${body.detail}${fields}`,
      );
    }

    res.setHeader('Content-Type', 'application/problem+json');
    res.status(mapped.status).json(body);
  }
}
