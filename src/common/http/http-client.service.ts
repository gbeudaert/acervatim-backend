import {
  BadGatewayException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [250, 750, 2250] as const;
const JITTER_RATIO = 0.2;

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  /** Override du timeout par défaut (10s). */
  timeoutMs?: number;
  /**
   * Nombre max de tentatives HTTP (défaut {@link MAX_ATTEMPTS}=3). Mettre à `1` pour désactiver le
   * retry transport quand le retry est déjà porté ailleurs à un meilleur étage — cas Google Books,
   * dont les 503 arrivent en vagues pluri-minutes gérées par le backoff exponentiel job-level
   * (cf. `GoogleBooksCoverService`) : retenter en ~2 s ne fait qu'ajouter du volume à un endpoint
   * déjà throttlé. Clampé à ≥1.
   */
  maxAttempts?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
}

class HttpRetryableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

class HttpClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

@Injectable()
export class HttpClientService implements OnModuleInit {
  private readonly logger = new Logger(HttpClientService.name);
  private userAgent!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const ua = this.config.get<string>('HTTP_USER_AGENT');
    if (!ua) {
      throw new Error('HTTP_USER_AGENT must be set');
    }
    this.userAgent = ua;
  }

  async request<T = unknown>(
    url: string,
    opts: HttpRequest = {},
  ): Promise<HttpResponse<T>> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_ATTEMPTS);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.doFetch<T>(url, opts, timeoutMs);
      } catch (err) {
        if (err instanceof HttpClientError) {
          // 4xx hors 429 — pas de retry.
          throw err;
        }
        const retryable = err as HttpRetryableError;
        const isLast = attempt === maxAttempts;
        if (isLast) {
          this.logger.warn(
            `http: upstream unavailable after ${maxAttempts} attempt(s) ${redactedTarget(url)} status=${retryable.status ?? 'network'}`,
          );
          throw new BadGatewayException('upstream unavailable');
        }
        const delay = retryable.retryAfterMs ?? backoff(attempt);
        this.logger.log(
          `http: retry ${attempt + 1}/${maxAttempts} ${redactedTarget(url)} status=${retryable.status ?? 'network'} delay=${delay}ms`,
        );
        await sleep(delay);
      }
    }

    // Unreachable — la boucle return / throw avant.
    throw new BadGatewayException('upstream unavailable');
  }

  private async doFetch<T>(
    url: string,
    opts: HttpRequest,
    timeoutMs: number,
  ): Promise<HttpResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          'User-Agent': this.userAgent,
          ...opts.headers,
        },
        body: opts.body,
        signal: controller.signal,
      });
    } catch (err) {
      // AbortError ou erreur réseau → retryable.
      throw new HttpRetryableError(
        err instanceof Error ? err.message : 'network error',
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw new HttpRetryableError(
        `429 too many requests`,
        429,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }
    if (res.status >= 500) {
      throw new HttpRetryableError(`${res.status} upstream error`, res.status);
    }
    if (res.status >= 400) {
      const body = await safeBody(res);
      throw new HttpClientError(`${res.status} client error`, res.status, body);
    }

    const data = (await safeBody(res)) as T;
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      data,
    };
  }
}

function backoff(attempt: number): number {
  const base = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
  const jitter = base * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.floor(base + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

async function safeBody(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  return await res.text();
}

/** Strip query string pour éviter d'embarquer un token Discogs en clair dans les logs. */
function redactedTarget(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export { HttpClientError, HttpRetryableError };
