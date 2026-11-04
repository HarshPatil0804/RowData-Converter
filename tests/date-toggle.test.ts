import { describe, expect, it } from 'vitest';
import { processBytes } from '../src/pipeline/index';
import type { DateOrderMode } from '../src/lib/dates';

/** One ambiguous date, and nothing in the file that could prove its order. */
const UNPROVEN = 'id,when,amount\n1,05-03-2024,10\n2,07-03-2024,20\n';

/** `18-03-2024` cannot be a month, so it proves DD-MM for the whole pattern. */
const PROVEN = 'id,when,amount\n1,18-03-2024,10\n2,05-03-2024,20\n';

async function convert(csv: string, dateOrder: DateOrderMode) {
  const datasets = await processBytes('dates.csv', 'text/csv', new TextEncoder().encode(csv), { dateOrder });
  const dataset = datasets[0];
  const when = dataset.columns.indexOf('when');
  const id = dataset.columns.indexOf('id');
  const byId = new Map<unknown, unknown>();
  for (const row of dataset.rows) byId.set(row[id], row[when]);
  const ambiguous = dataset.report.flagCounts.find((flag) => flag.name === 'date_ambiguous')?.count ?? 0;
  return { byId, ambiguous, report: dataset.report };
}

describe('R3 date toggle honesty', () => {
  it('without proof: the toggle really changes the value, and auto leaves it as written', async () => {
    const auto = await convert(UNPROVEN, 'auto');
    const dm = await convert(UNPROVEN, 'DM');
    const md = await convert(UNPROVEN, 'MD');

    // Unproven dates are not guessed: the original string survives and the row
    // is flagged for review.
    expect(auto.ambiguous).toBe(2);
    expect(String(auto.byId.get(1))).toMatch(/05-03-2024/);

    // Flipping the toggle applies the chosen order to exactly those values.
    expect(String(dm.byId.get(1))).toBe('2024-03-05');
    expect(String(md.byId.get(1))).toBe('2024-05-03');
    expect(String(dm.byId.get(2))).toBe('2024-03-07');
    expect(String(md.byId.get(2))).toBe('2024-07-03');

    // And the two flips disagree, i.e. the test would fail if the toggle were a
    // no-op: this is what the earlier "re-run in 31 ms" check never proved.
    expect(String(dm.byId.get(1))).not.toBe(String(md.byId.get(1)));
  });

  it('with proof: a day above 12 pins the order, so the toggle changes nothing', async () => {
    const auto = await convert(PROVEN, 'auto');
    const dm = await convert(PROVEN, 'DM');
    const md = await convert(PROVEN, 'MD');

    for (const result of [auto, dm, md]) {
      expect(String(result.byId.get(1))).toBe('2024-03-18');
      expect(String(result.byId.get(2))).toBe('2024-03-05');
    }
    // Nothing is ambiguous once the data proves the order.
    expect(auto.ambiguous).toBe(0);
    expect(String(dm.byId.get(2))).toBe(String(md.byId.get(2)));
  });
});
