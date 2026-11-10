import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, type Tuning } from '../src/pipeline/typing';
import { DOMAINS } from './fuzz/generators';
import { runCase } from './fuzz/runner';

/**
 * Threshold sweep.
 *
 * Every tolerant decision in `src/pipeline/typing.ts` sits on a threshold. A
 * threshold chosen because it happens to fit one fixture is not a rule, it is a
 * lookup table — so each one is swept over four values here and the accuracy is
 * printed for every value. What the sweep has to show is *stability*: the rules
 * keep working when the number moves, which means they are driven by the shape
 * of the data rather than by the exact cut-off.
 *
 * The values are deliberately far apart (the default plus a much stricter and a
 * much looser neighbour, and a fourth for the edges), and the assertions are on
 * the *range*, not on the default winning: no value may take accuracy below
 * 98%, and no value may change the row accounting at all.
 */

/** Injectors that each threshold actually governs. */
const SWEEPS: { key: keyof Tuning; values: number[]; injectors: string[]; why: string }[] = [
  {
    key: 'numericMajority',
    values: [0.4, 0.6, 0.75, 0.9],
    injectors: ['text in numeric', 'numeric affixes', 'numeric units'],
    why: 'how much of a column must parse before it becomes numeric; looser values tempt a text column into numbers, tighter ones strand parseable cells',
  },
  {
    key: 'dateMajority',
    values: [0.4, 0.6, 0.75, 0.9],
    injectors: ['mixed dates', 'excel serials', 'datetime forms'],
    why: 'how much of a column must parse as dates; looser values turn id-like numbers into dates',
  },
  {
    key: 'booleanMajority',
    values: [0.75, 0.85, 0.9, 0.97],
    injectors: ['boolean vocabulary', 'text in numeric'],
    why: 'how much of a column must be one boolean family; looser values swallow prose columns',
  },
  {
    key: 'emailShare',
    values: [0.7, 0.8, 0.9, 0.97],
    injectors: ['emails'],
    why: 'how much of a column must be email-shaped before addresses are lowercased',
  },
  {
    key: 'phoneShare',
    values: [0.5, 0.7, 0.85, 0.95],
    injectors: ['phones'],
    why: 'how much of a column must be phone-shaped before separators are stripped',
  },
  {
    key: 'fractionShare',
    values: [0.7, 0.85, 0.9, 0.97],
    injectors: ['score fractions'],
    why: 'how much of a column must share one denominator before n/N becomes a number',
  },
  {
    key: 'unitShare',
    values: [0.03, 0.05, 0.1, 0.2],
    injectors: ['numeric units', 'numeric affixes'],
    why: 'how often a unit word must recur before it counts as a unit and not as text',
  },
  {
    key: 'unitMax',
    values: [3, 5, 8, 12],
    injectors: ['numeric units'],
    why: 'how many distinct unit words a column may hold and still be numeric',
  },
  {
    key: 'unitNumeric',
    values: [0.75, 0.85, 0.9, 0.97],
    injectors: ['numeric units'],
    why: 'how much of a column must parse once the unit is stripped',
  },
  {
    key: 'magnitudeFactor',
    values: [10, 30, 100, 300],
    injectors: ['numeric magnitudes'],
    why: 'how far a k/L/M/cr value may sit from the column median; tighter values make 3M inconsistent with 3,000,000 and print a payout column as text',
  },
];

describe('threshold sweep – accuracy is a plateau, not a lucky point', () => {
  it('holds across four values of every typing threshold', async () => {
    const lines: string[] = [
      '',
      '=== Threshold sweep (accuracy over the governed injectors, all domains) ===',
      'threshold             value    cases  accuracy  rowLoss  default',
    ];

    for (const sweep of SWEEPS) {
      for (const value of sweep.values) {
        let cases = 0;
        let cells = 0;
        let matched = 0;
        let losses = 0;
        for (const domain of DOMAINS) {
          for (const injector of sweep.injectors) {
            for (let seed = 1; seed <= 2; seed += 1) {
              const result = await runCase(domain, seed, [injector], { [sweep.key]: value } as Partial<Tuning>);
              cases += 1;
              cells += result.cellsTotal;
              matched += result.cellsMatch;
              if (result.rowLoss) losses += 1;
            }
          }
        }
        const accuracy = cells === 0 ? 0 : matched / cells;
        lines.push(
          `${sweep.key.padEnd(20)} ${String(value).padStart(5)}  ${String(cases).padStart(6)}  ` +
            `${(accuracy * 100).toFixed(2).padStart(8)}%  ${String(losses).padStart(7)}  ` +
            `${value === DEFAULT_TUNING[sweep.key] ? 'yes' : ''}`,
        );
        // The plateau: no single value of any threshold may break a governed case.
        expect(accuracy, `${sweep.key}=${value} (${sweep.why})`).toBeGreaterThanOrEqual(0.98);
        expect(losses, `${sweep.key}=${value} row accounting`).toBe(0);
      }
    }

    lines.push(
      '',
      'Every governance threshold keeps its governed cases at or above 98% across the',
      'whole range, so the defaults are a plateau rather than a single fitting point.',
    );
    console.log(lines.join('\n'));
  }, 300_000);
});
