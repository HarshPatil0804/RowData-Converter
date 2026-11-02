import { describe, expect, it } from 'vitest';
import { DOMAINS } from './generators';
import { runCase } from './runner';

describe('fuzz smoke', () => {
  it('one clean-ish case', async () => {
    const result = await runCase(DOMAINS[0], 1, []);
    console.log(JSON.stringify(result, null, 2));
    expect(result.rowLoss).toBe(false);
    expect(result.missingColumns).toEqual([]);
    expect(result.accuracy).toBeGreaterThan(0.99);
  }, 30000);

  it('currency only', async () => {
    const result = await runCase(DOMAINS[0], 2, ['currency']);
    console.log(JSON.stringify(result, null, 2));
    expect(result.rowLoss).toBe(false);
    expect(result.missingColumns).toEqual([]);
    expect(result.accuracy).toBeGreaterThan(0.99);
  }, 30000);

  it('kitchen sink', async () => {
    const result = await runCase(DOMAINS[0], 3, [
      'case', 'whitespace', 'quotes', 'mixed dates', 'currency', 'text in numeric',
      'spelled numbers', 'prefixed ids', 'missing ids', 'multi item', 'overlapping category',
      'key=value packed', 'A / B composite', 'paren qualifier', 'conflicting duplicates',
      'exact duplicates', 'preamble', 'footer', 'blank rows', 'delimiter', 'bom + newline mix',
    ]);
    console.log(JSON.stringify(result, null, 2));
    expect(result.missingColumns).toEqual([]);
    expect(result.rowLoss).toBe(false);
    expect(result.accuracy).toBeGreaterThan(0.95);
  }, 30000);
});
