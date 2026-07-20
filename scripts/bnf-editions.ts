/**
 * Analyse jetable : pour chaque ISBN de test, relève l'édition (BnF 205$a) via `BnfService`.
 * But : identifier les tomes d'ÉDITION SPÉCIALE (Colossale / Perfect / Prestige…), qui posent
 * problème pour les jaquettes (numérotation + visuel distincts, non couverts par MangaDex).
 *
 * Usage (conteneur app) :
 *   docker compose exec -T app npx ts-node --transpile-only scripts/bnf-editions.ts [fichier.txt]
 */
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'fs';
import { AppModule } from '../src/app.module';
import { BnfService } from '../src/common/sources/bnf/bnf.service';

const DEFAULT_INPUT = 'test/fixtures/scanned-isbns.txt';

function readIsbns(path: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const code = t.split(/\s+/)[0].replace(/[^0-9Xx]/g, '');
    if (code && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

async function mapC<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const res = new Array<R>(items.length);
  let i = 0;
  const w = async () => {
    while (i < items.length) {
      const k = i++;
      res[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w));
  return res;
}

async function main(): Promise<void> {
  const input = process.argv[2] ?? DEFAULT_INPUT;
  const isbns = readIsbns(input);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const bnf = app.get(BnfService, { strict: false });
    const rows = await mapC(isbns, 3, async (isbn) => {
      const r = await bnf.resolveByIsbn(isbn);
      if (!r.ok) return { isbn, status: r.reason, edition: null as string | null, titleFr: null, series: null, vol: null };
      return {
        isbn,
        status: 'ok',
        edition: r.notice.edition,
        titleFr: r.notice.titleFr,
        series: r.notice.seriesTitle,
        vol: r.notice.volume,
      };
    });

    const pad = (s: unknown, n: number) => String(s ?? '').padEnd(n).slice(0, n);
    console.log(pad('ISBN', 15) + pad('édition (205$a)', 22) + pad('tome', 6) + pad('titre / série', 40));
    console.log('-'.repeat(83));
    for (const r of rows) {
      const flag = r.edition ? '  <<< SPÉCIALE' : '';
      const label = r.status === 'ok' ? `${r.titleFr ?? ''} / ${r.series ?? ''}` : `(${r.status})`;
      console.log(pad(r.isbn, 15) + pad(r.edition ?? (r.status === 'ok' ? 'standard' : '-'), 22) + pad(r.vol ?? '-', 6) + pad(label, 40) + flag);
    }
    const special = rows.filter((r) => r.edition);
    const std = rows.filter((r) => r.status === 'ok' && !r.edition);
    const ko = rows.filter((r) => r.status !== 'ok');
    console.log(`\nTOTAL ${rows.length} : ${std.length} standard, ${special.length} édition spéciale, ${ko.length} non trouvé BnF`);
    if (special.length) {
      console.log('Éditions spéciales : ' + special.map((r) => `${r.isbn}="${r.edition}"`).join(', '));
    }
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exitCode = 1;
});
