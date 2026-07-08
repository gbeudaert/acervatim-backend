import { Job } from 'bullmq';
import { BnfProcessor } from './bnf.processor';
import { BnfFetchJobData } from './bnf.types';

function job(url: string): Job<BnfFetchJobData, string> {
  return { data: { url } } as Job<BnfFetchJobData, string>;
}

describe('BnfProcessor.process', () => {
  it('récupère l’URL SRU et renvoie le XML (string)', async () => {
    const http = {
      request: jest
        .fn()
        .mockResolvedValue({ status: 200, headers: {}, data: '<xml/>' }),
    };
    const proc = new BnfProcessor(http as never);

    const out = await proc.process(job('https://catalogue.bnf.fr/api/SRU?q=1'));

    expect(out).toBe('<xml/>');
    expect(http.request).toHaveBeenCalledWith(
      'https://catalogue.bnf.fr/api/SRU?q=1',
      { method: 'GET' },
    );
  });

  it('coerce une donnée non-string en string', async () => {
    const http = {
      request: jest
        .fn()
        .mockResolvedValue({ status: 200, headers: {}, data: 42 }),
    };
    const proc = new BnfProcessor(http as never);
    expect(await proc.process(job('u'))).toBe('42');
  });
});
