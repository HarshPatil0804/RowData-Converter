/**
 * Temporary diagnosis for the last two review gaps:
 *   1. shipments · overlapping category (overlap not surfaced)
 *   2. school marks · missing ids + quotes + currency + footer (R14 not fired)
 * Run: npx vite-node tests/fuzz/debug-gaps.ts
 */
import { DOMAINS } from './generators';
import { buildCase, groundTruthFor, processText } from './runner';

// ---- 1. overlap ------------------------------------------------------------
{
  const domain = DOMAINS.find((d) => d.name === 'shipments')!;
  for (const seed of [1, 2]) {
    const gt = groundTruthFor(domain, seed);
    const { text, ctx } = buildCase(gt, seed, ['overlapping category']);
    const ds = await processText('debug.csv', text);
    console.log(`\n=== overlap seed ${seed} ===`);
    console.log('overlapColumns:', [...ctx.overlapColumns], 'colName:', [...ctx.colName.entries()].map(([k, v]) => `${k}:${v}`).join(' '));
    console.log('clean columns:', ds.columns.join(' | '));
    console.log('types       :', ds.report.columns.map((c) => `${c.name}=${c.type}`).join(' | '));
    console.log('overlapping :', JSON.stringify(ds.report.overlapping));
    console.log('review kinds:', ds.review.map((r) => r.kind).join(','));
    console.log('rulesFired  :', ds.report.rulesFired.join(','));
    const [col] = ctx.overlapColumns;
    if (col !== undefined) {
      const name = ctx.colName.get(col)!;
      const ci = ds.columns.indexOf(name);
      console.log('target column:', name, 'cleanIndex:', ci);
      if (ci >= 0) {
        const vals = ds.rows.map((r) => r[ci]);
        console.log('values:', JSON.stringify(vals.slice(0, 20)));
      }
      console.log('expected values:', JSON.stringify(gt.rows.map((r) => r[col]).slice(0, 20)));
    }
  }
}

// ---- 2. missing ids --------------------------------------------------------
{
  const domain = DOMAINS.find((d) => d.name === 'school marks')!;
  const chosen = ['missing ids', 'quotes', 'currency', 'footer'];
  for (const seed of [1, 2]) {
    const gt = groundTruthFor(domain, seed);
    const { text, ctx } = buildCase(gt, seed, chosen);
    const ds = await processText('debug.csv', text);
    console.log(`\n=== missing_id seed ${seed} ===`);
    console.log('header:', ctx.header.join(' | '));
    console.log('position:', JSON.stringify(ctx.position));
    const idCol = gt.header.findIndex((n, i) => /id|roll|no/i.test(n) && ctx.position[i] >= 0);
    console.log('candidate id gt col:', idCol, gt.header[idCol]);
    const name = ctx.colName.get(idCol)!;
    const ci = ds.columns.indexOf(name);
    console.log('clean id column:', name, 'idx:', ci);
    if (ci >= 0) {
      const vals = ds.rows.map((r) => r[ci]);
      console.log('values:', JSON.stringify(vals.slice(0, 25)));
      console.log('nullish count:', vals.filter((v) => v === null || v === undefined || (typeof v === 'string' && !v.trim())).length, '/', vals.length);
    }
    console.log('clean columns:', ds.columns.join(' | '));
    console.log('rulesFired:', ds.report.rulesFired.join(','));
    console.log('review kinds:', ds.review.map((r) => r.kind).join(','));
    console.log('row0 serialized:', text.split('\n')[1]);
  }
}