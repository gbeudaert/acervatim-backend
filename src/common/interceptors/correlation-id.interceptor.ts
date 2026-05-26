import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

const HEADER = 'x-request-id';

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const incoming = req.headers[HEADER];
    const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();

    req.requestId = id;
    res.setHeader('X-Request-Id', id);

    return next.handle();
  }
}
