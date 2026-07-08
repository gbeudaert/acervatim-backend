import { BullModule } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ApiCacheService } from '../../cache/api-cache.service';
import { HttpClientService } from '../../http/http-client.service';
import { BnfProcessor } from './bnf.processor';
import { BnfService } from './bnf.service';
import { BNF_QUEUE } from './bnf.types';

/**
 * E2E de la file `bnf` contre un **vrai Redis** : `BnfService` → file → `BnfProcessor` (worker réel)
 * → `waitUntilFinished`. `HttpClientService` est **stubé** (aucun appel à la vraie BnF), le cache est
 * en mémoire (pas de MariaDB). On valide le throttle single-flight de bout en bout.
 */

const NOTICE_XML = `<srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
  <srw:numberOfRecords>1</srw:numberOfRecords>
  <srw:records><srw:record><srw:recordData>
    <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
      <mxc:datafield tag="200" ind1="1" ind2=" "><mxc:subfield code="a">L'attaque des titans</mxc:subfield><mxc:subfield code="h">1</mxc:subfield></mxc:datafield>
      <mxc:datafield tag="454" ind1=" " ind2="1"><mxc:subfield code="t">Shingeki no kyojin</mxc:subfield></mxc:datafield>
      <mxc:datafield tag="700" ind1=" " ind2="1"><mxc:subfield code="a">Isayama</mxc:subfield></mxc:datafield>
    </mxc:record>
  </srw:recordData></srw:record></srw:records>
</srw:searchRetrieveResponse>`;

class InMemoryCache {
  readonly store = new Map<string, unknown>();
  async getOrFetch<T>(
    key: string,
    _ttl: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    if (this.store.has(key)) return this.store.get(key) as T;
    const v = await fetcher();
    this.store.set(key, v);
    return v;
  }
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async set<T>(key: string, v: T): Promise<void> {
    this.store.set(key, v);
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Bnf queue (e2e, Redis réel)', () => {
  let app: INestApplication;
  let svc: BnfService;
  let http: { request: jest.Mock };
  let queue: Queue;

  beforeAll(async () => {
    const cache = new InMemoryCache();
    http = { request: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            connection: {
              host: config.get<string>('REDIS_HOST', 'localhost'),
              port: config.get<number>('REDIS_PORT', 6379),
            },
          }),
        }),
        BullModule.registerQueue({ name: BNF_QUEUE }),
      ],
      providers: [
        BnfService,
        BnfProcessor,
        { provide: ApiCacheService, useValue: cache },
        { provide: HttpClientService, useValue: http },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    svc = app.get(BnfService);
    queue = app.get(getQueueToken(BNF_QUEUE));
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await app?.close();
  });

  beforeEach(() => http.request.mockReset());

  it('résout un ISBN de bout en bout via la file', async () => {
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: NOTICE_XML,
    });

    const res = await svc.resolveByIsbn('9782811623258');

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.notice.originalTitle).toBe('Shingeki no kyojin');
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it('single-flight : deux lookups concurrents du même ISBN → un seul fetch', async () => {
    http.request.mockImplementation(async () => {
      await delay(120);
      return { status: 200, headers: {}, data: NOTICE_XML };
    });

    const [a, b] = await Promise.all([
      svc.resolveByIsbn('9782811999999'),
      svc.resolveByIsbn('9782811999999'),
    ]);

    expect(a.ok && b.ok).toBe(true);
    expect(http.request).toHaveBeenCalledTimes(1);
  });
});
