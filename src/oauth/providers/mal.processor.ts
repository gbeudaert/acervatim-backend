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
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TokenResolverService } from '../token-resolver.service';
import { MAL_QUEUE, MalFetchJobData } from './mal.types';

/**
 * Seul point qui appelle réellement MyAnimeList. Le **limiter** (débit sortant global, tous users
 * confondus) remplace les buckets `mal:<userId>` + `acervatim:mal`. Calibré sur l'ancien bucket
 * partagé Acervatim (≈ 2 req/s) ; à re-calibrer en P3 sur le budget réel du compte MAL.
 *
 * **Résolution du jeton DANS le worker** (jamais en clair dans Redis) : le job porte le `userId`, le
 * worker en dérive le mode d'accès et pose le bon header :
 *  - `user`     → `Authorization: Bearer <token>` (BYOT) ;
 *  - `fallback` → `X-MAL-CLIENT-ID <MAL_CLIENT_ID serveur>` (données publiques, repli premium).
 * Le producteur (`MalAdapter`) a déjà écarté le mode dégradé (`none`) avant d'enfiler ; on le
 * re-vérifie ici par sécurité (jeton user disparu / premium expiré entre-temps).
 */
@Injectable()
@Processor(MAL_QUEUE, { concurrency: 2, limiter: { max: 3, duration: 1000 } })
export class MalProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(MalProcessor.name);
  private clientId?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
    private readonly tokenResolver: TokenResolverService,
  ) {
    super();
  }

  onModuleInit(): void {
    this.clientId = this.config.get<string>('MAL_CLIENT_ID');
  }

  async process(job: Job<MalFetchJobData, unknown>): Promise<unknown> {
    const { userId, url } = job.data;
    const resolution = await this.tokenResolver.resolve(userId, 'mal');

    if (resolution.source === 'user') {
      const res = await this.http.request<unknown>(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${resolution.credentials.accessToken}`,
        },
      });
      return res.data;
    }

    if (resolution.source === 'fallback') {
      const res = await this.http.request<unknown>(url, {
        method: 'GET',
        headers: { 'X-MAL-CLIENT-ID': this.requireClientId() },
      });
      return res.data;
    }

    // Cas rare : le jeton user a disparu / le premium a expiré entre le gating du producteur et
    // l'exécution du job.
    throw new SourceTokenRequiredException('mal');
  }

  private requireClientId(): string {
    if (!this.clientId) {
      this.logger.error(
        'MAL_CLIENT_ID not configured — repli premium impossible',
      );
      throw new ServiceUnavailableException('mal: not configured');
    }
    return this.clientId;
  }
}
