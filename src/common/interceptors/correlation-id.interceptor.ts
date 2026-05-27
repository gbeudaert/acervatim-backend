import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

const HEADER = 'x-request-id';
// UUID v1-v5 (8-4-4-4-12 hex). Refuse tout autre format → on régénère.
// Évite la log-injection (séquences ANSI, payloads SQL/log4j) via un header
// non valide réutilisé tel quel dans les logs et les Problem Details.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const incoming = req.headers[HEADER];
    const id =
      typeof incoming === 'string' && UUID_RE.test(incoming)
        ? incoming
        : randomUUID();

    req.requestId = id;
    res.setHeader('X-Request-Id', id);

    return next.handle();
  }
}
