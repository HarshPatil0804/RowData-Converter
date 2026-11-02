/**
 * Accuracy table – the main fairness measurement.
 *
 * For every (domain × injector × seed) we build the messy file from ground
 * truth, push it through the REAL pipeline, and grade it cell by cell after
 * canonicalization. Thresholds:
 *   - single injector: cell accuracy ≥ 98%
 *   - random combination of 4 injectors: ≥ 95%
 *   - zero silent row loss, ever (rows_in = clean + rejected + duplicates)
 *   - every unresolved ambiguity must be surfaced in Needs review
 *
 * The table is printed so regressions are visible in plain numbers.
 * `npm run fuzz -- --seeds=2000` runs the same machinery at scale.
 */
import { describe, expect, it } from 'vitest';
import { DOMAINS } from './generators';
import { INJECTORS } from './injectors';
import { makeRng } from './random';
import { runCase, type CaseResult } from './runner';

const INJECTOR_NAMES = INJECTORS.map((injector) => injector.name);

interface Aggregate {
  cases: number;
  cells: number;
  match: number;
  losses: number;
  reviewGaps: number;
}

function aggregate(): Aggregate {
  return { cases: 0, cells: 0, match: 0, losses: 0, reviewGaps: 0 };
}

function fold(into: Aggregate, result: CaseResult): void {
  into.cases += 1;
  into.cells += result.cellsTotal;
  into.match += result.cellsMatch;
  if (result.rowLoss) into.losses += 1;
  if (result.reviewMissing.length > 0) into.reviewGaps += 1;
}

function accuracy(agg: Aggregate): number {
  return agg.cells === 0 ? 1 : agg.match / agg.cells;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

describe('fuzz accuracy table', () => {
  it(
    'meets the per-injector (98%) and combo (95%) thresholds',
    async () => {
      const seedCount = Number(
        process.env.FUZZ_SEEDS ?? process.argv.find((a) => a.startsWith('--seeds='))?.split('=')[1] ?? 4,
      );

      const singles = new Map<string, Aggregate>();
      const combos = new Map<string, Aggregate>();
      const failures: string[] = [];
      let totalCases = 0;

      // ---- single injectors: every domain × every injector × N seeds ----
      for (const domain of DOMAINS) {
        for (const name of INJECTOR_NAMES) {
          const agg = aggregate();
          for (let seed = 1; seed <= seedCount; seed += 1) {
            const result = await runCase(domain, seed, [name]);
            fold(agg, result);
            totalCases += 1;
            if (result.rowLoss || result.errors.length > 0 || result.reviewMissing.length > 0) {
              failures.push(
                `${result.label}: acc=${pct(result.accuracy)} rowLoss=${result.rowLoss} ` +
                  `reviewMissing=${result.reviewMissing.join('|') || '-'} errors=${result.errors.join(' | ') || '-'}`,
              );
            }
          }
          singles.set(`${domain.name} :: ${name}`, agg);
        }
      }

      // ---- random combinations of exactly 4 injectors, mixed phases ----
      const comboSeeds = Math.max(seedCount, 2);
      for (const domain of DOMAINS) {
        for (let pick = 0; pick < 4; pick += 1) {
          const rng = makeRng(0xc0ffee + pick * 31 + DOMAINS.indexOf(domain));
          const chosen = rng.pickMany(INJECTOR_NAMES, 4);
          const key = chosen.join(' + ');
          const agg = combos.get(key) ?? aggregate();
          for (let seed = 1; seed <= comboSeeds; seed += 1) {
            const result = await runCase(domain, seed, chosen);
            fold(agg, result);
            totalCases += 1;
            if (result.rowLoss || result.accuracy < 0.95 || result.reviewMissing.length > 0) {
              failures.push(
                `${result.label}: acc=${pct(result.accuracy)} rowLoss=${result.rowLoss} ` +
                `reviewMissing=${result.reviewMissing.join('|') || '-'} errors=${result.errors.join(' | ') || '-'}`,
              );
            }
          }
          combos.set(key, agg);
        }
      }

      // ---- print the table -------------------------------------------------
      const lines: string[] = ['', '=== Fuzz accuracy table (single injectors) ==='];
      lines.push('domain            injector                    cases  accuracy  rowLoss  reviewGaps');
      for (const [key, agg] of [...singles.entries()].sort()) {
        const [domain, injector] = key.split(' :: ');
        lines.push(
          `${domain.padEnd(16)} ${injector.padEnd(26)} ${String(agg.cases).padStart(5)}  ` +
            `${pct(accuracy(agg)).padStart(8)}  ${String(agg.losses).padStart(7)}  ${String(agg.reviewGaps).padStart(11)}`,
        );
      }
      lines.push('', '=== Fuzz accuracy table (combinations of 4 injectors) ===');
      lines.push('combination                                          cases  accuracy  rowLoss');
      for (const [key, agg] of [...combos.entries()].sort()) {
        lines.push(
          `${key.padEnd(50)} ${String(agg.cases).padStart(5)}  ${pct(accuracy(agg)).padStart(8)}  ${String(agg.losses).padStart(7)}`,
        );
      }
      lines.push('', `total seeded cases: ${totalCases}`);
      console.log(lines.join('\n'));

      // ---- report failures first so diagnosis is visible -------------------
      if (failures.length > 0) {
        console.error(`\n${failures.length} failing case(s):\n${failures.join('\n')}`);
      }

      // ---- threshold assertions -------------------------------------------
      const worstSingle = [...singles.entries()]
        .map(([key, agg]) => ({ key, acc: accuracy(agg) }))
        .sort((a, b) => a.acc - b.acc)[0];
      const worstCombo = [...combos.entries()]
        .map(([key, agg]) => ({ key, acc: accuracy(agg) }))
        .sort((a, b) => a.acc - b.acc)[0];

      if (!process.env.FUZZ_SEEDS) expect(totalCases).toBeGreaterThanOrEqual(200);
      expect(worstSingle.acc, `worst single injector: ${worstSingle.key}`).toBeGreaterThanOrEqual(0.98);
      expect(worstCombo.acc, `worst combo: ${worstCombo.key}`).toBeGreaterThanOrEqual(0.95);

      for (const agg of singles.values()) {
        expect(agg.losses, 'zero silent row loss (single injectors)').toBe(0);
        expect(agg.reviewGaps, 'every ambiguity surfaced in Needs review').toBe(0);
      }
      for (const agg of combos.values()) {
        expect(agg.losses, 'zero silent row loss (combos)').toBe(0);
        expect(agg.reviewGaps, 'every ambiguity surfaced in Needs review (combos)').toBe(0);
      }

      expect(failures, `failing cases:\n${failures.slice(0, 20).join('\n')}`).toEqual([]);
    },
    600000,
  );
});