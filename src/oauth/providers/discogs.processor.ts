import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { HttpClientService } from '../../common/http/http-client.service';
import { DecryptedCredentials } from '../oauth.service';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TokenResolverService } from '../token-resolver.service';
import { DISCOGS_QUEUE, DiscogsFetchJobData } from './discogs.types';
import { buildOAuth1Header, OAuth1Credentials } from './oauth1';

/**
 * Seul point qui appelle réellement Discogs. Le **limiter** (débit sortant global, tous users
 * confondus) remplace les buckets `discogs:<userId>` + `acervatim:discogs`. Calibré sur la limite
 * Discogs authentifiée (~60 req/min = 1/s) ; à re-calibrer en P3 sur le budget réel du compte.
 *
 * **Signature OAuth 1.0a DANS le worker** (jamais de secret dans Redis) : le job porte le `userId`,
 * le worker en résout le mode d'accès et pose le bon header `Authorization` :
 *  - `user`     → signature OAuth 1.0a avec le couple consumer + le token/secret utilisateur (BYOT) ;
 *  - `fallback` → repli premium : `Discogs token=<personal token Acervatim>` si configuré (renvoie
 *    les images), sinon signature **consumer-only** (authentifiée, sans images) ;
 *  - `none`     → mode dégradé (ne devrait pas arriver : le producteur a déjà gaté) → 403.
 * Le producteur (`DiscogsAdapter`) a écarté `none` avant d'enfiler ; on le re-vérifie ici par
 * sécurité (jeton user disparu / premium expiré entre-temps).
 */
@Injectable()
@Processor(DISCOGS_QUEUE, {
  concurrency: 2,
  limiter: { max: 1, duration: 1000 },
})
export class DiscogsProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(DiscogsProcessor.name);
  private consumerKey?: string;
  private consumerSecret?: string;
  /** Personal access token d'un compte Acervatim, pour le repli premium (images). */
  private acervatimToken?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
    private readonly tokenResolver: TokenResolverService,
  ) {
    super();
  }

  onModuleInit(): void {
    this.consumerKey = this.config.get<string>('DISCOGS_CONSUMER_KEY');
    this.consumerSecret = this.config.get<string>('DISCOGS_CONSUMER_SECRET');
    this.acervatimToken = this.config.get<string>('DISCOGS_ACERVATIM_TOKEN');
  }

  async process(job: Job<DiscogsFetchJobData, unknown>): Promise<unknown> {
    const { userId, url } = job.data;
    const resolution = await this.tokenResolver.resolve(userId, 'discogs');

    if (resolution.source === 'none') {
      // Cas rare : jeton user disparu / premium expiré entre le gating du producteur et l'exécution.
      throw new SourceTokenRequiredException('discogs');
    }

    const authHeader =
      resolution.source === 'user'
        ? this.buildSignedHeader(url, resolution.credentials)
        : this.buildFallbackHeader(url);

    const res = await this.http.request<unknown>(url, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    return res.data;
  }

  /**
   * Header du repli premium. Personal access token Acervatim s'il est configuré (`Discogs token=` —
   * authentifié ET renvoie les images), sinon signature consumer-only (authentifiée, sans images).
   */
  private buildFallbackHeader(url: string): string {
    if (this.acervatimToken) {
      return `Discogs token=${this.acervatimToken}`;
    }
    return this.buildSignedHeader(url, null);
  }

  /**
   * En-tête OAuth 1.0a : signé avec le token user si présent, sinon consumer-only (repli premium sans
   * personal token — authentifié mais sans images). La signature porte sur l'URL SANS query-string +
   * les query params comme `extraParams` (exigence RFC 5849).
   */
  private buildSignedHeader(
    url: string,
    userCreds: DecryptedCredentials | null,
  ): string {
    const consumer = this.requireConsumer();
    const creds: OAuth1Credentials = userCreds
      ? {
          ...consumer,
          tokenKey: userCreds.accessToken,
          // Stocké dans refreshToken — cf. DiscogsAdapter.callback().
          tokenSecret: userCreds.refreshToken,
        }
      : consumer;
    return buildOAuth1Header('GET', stripQuery(url), creds, queryParams(url));
  }

  private requireConsumer(): OAuth1Credentials {
    if (!this.consumerKey || !this.consumerSecret) {
      this.logger.error(
        'DISCOGS_CONSUMER_KEY / DISCOGS_CONSUMER_SECRET not configured',
      );
      throw new ServiceUnavailableException('discogs: not configured');
    }
    return {
      consumerKey: this.consumerKey,
      consumerSecret: this.consumerSecret,
    };
  }
}

function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function queryParams(url: string): Record<string, string> {
  const q = url.indexOf('?');
  if (q === -1) return {};
  const params = new URLSearchParams(url.slice(q + 1));
  const out: Record<string, string> = {};
  params.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}
