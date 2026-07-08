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
import { TMDB_QUEUE, TmdbFetchJobData } from './tmdb.types';

/**
 * Seul point qui appelle réellement TMDB. Le **limiter** (débit sortant global, tous users
 * confondus) remplace les buckets `tmdb:global` + `acervatim:tmdb`.
 *
 * **Résolution de la clé DANS le worker** (jamais en clair dans Redis) : le job porte le `userId`,
 * le worker en dérive la clé (perso BYOT si connectée, sinon clé serveur Acervatim pour un premium)
 * et l'injecte dans l'URL. Le producteur (`TmdbAdapter`) a déjà écarté le mode dégradé (`none`)
 * avant d'enfiler ; on le re-vérifie ici par sécurité (premium expiré entre-temps).
 */
@Injectable()
@Processor(TMDB_QUEUE, { concurrency: 4, limiter: { max: 20, duration: 1000 } })
export class TmdbProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(TmdbProcessor.name);
  private serverApiKey?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
    private readonly tokenResolver: TokenResolverService,
  ) {
    super();
  }

  onModuleInit(): void {
    this.serverApiKey = this.config.get<string>('TMDB_API_KEY');
  }

  async process(job: Job<TmdbFetchJobData, unknown>): Promise<unknown> {
    const { userId, url } = job.data;
    const resolution = await this.tokenResolver.resolve(userId, 'tmdb');

    let apiKey: string;
    if (resolution.source === 'user') {
      apiKey = resolution.credentials.accessToken;
    } else if (resolution.source === 'fallback') {
      apiKey = this.requireServerApiKey();
    } else {
      // Cas rare : le premium a expiré entre le gating du producteur et l'exécution.
      throw new SourceTokenRequiredException('tmdb');
    }

    const sep = url.includes('?') ? '&' : '?';
    const res = await this.http.request<unknown>(
      `${url}${sep}api_key=${apiKey}`,
    );
    return res.data;
  }

  private requireServerApiKey(): string {
    if (!this.serverApiKey) {
      this.logger.error('TMDB_API_KEY not configured');
      throw new ServiceUnavailableException('tmdb: not configured');
    }
    return this.serverApiKey;
  }
}
