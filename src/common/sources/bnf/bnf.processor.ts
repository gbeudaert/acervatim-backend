import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { HttpClientService } from '../../http/http-client.service';
import { BNF_QUEUE, BnfFetchJobData } from './bnf.types';

/**
 * Seul point qui interroge réellement le SRU BnF. Le **limiter** (débit sortant borné, tous users
 * confondus) et la **concurrence** remplacent l'ancien bucket `bnf:global`. `concurrency: 2` : deux
 * requêtes de front, si bien qu'une énumération de fond (priorité basse) ne bloque jamais un lookup
 * interactif (priorité haute) — la priorité gouverne l'ordre de prise, pas la préemption.
 *
 * Renvoie le XML brut ; le parsing UNIMARC et la mise en cache restent côté `BnfService`.
 */
@Processor(BNF_QUEUE, { concurrency: 2, limiter: { max: 10, duration: 1000 } })
export class BnfProcessor extends WorkerHost {
  constructor(private readonly http: HttpClientService) {
    super();
  }

  async process(job: Job<BnfFetchJobData, string>): Promise<string> {
    const res = await this.http.request<string>(job.data.url, {
      method: 'GET',
    });
    return typeof res.data === 'string' ? res.data : String(res.data);
  }
}
