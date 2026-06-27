import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

const HEADER = 'x-request-id';
// Meme validation que CorrelationIdInterceptor : refuse un header non UUID
// (anti log-injection : sequences ANSI / payloads reinjectes dans les logs).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Access log : une ligne par requete entrante, emise sur l'evenement `finish`
 * de la reponse. Middleware (pas interceptor) pour s'executer AVANT les guards :
 * couvre donc aussi les requetes rejetees en amont (401 JWT, 429 throttler).
 *
 * Pose `req.requestId` au plus tot pour que toute la chaine (interceptor de
 * correlation, ProblemDetailsExceptionFilter, logs d'erreur) partage le meme id.
 *
 * Privacy by design : ne loggue jamais les headers (Authorization), ni le body.
 * `userId` est l'UUID opaque applicatif (non re-identifiant sans le pepper).
 */
@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[HEADER];
    const requestId =
      typeof incoming === 'string' && UUID_RE.test(incoming)
        ? incoming
        : randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      const user = req.userId ?? '-';
      this.logger.log(
        `${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms req=${requestId} user=${user}`,
      );
    });

    next();
  }
}
