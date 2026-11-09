import { describe, expect, it } from 'vitest';
import { processBytes } from '../src/pipeline/index';
import { toCSV } from '../src/lib/export';
import type { Dataset } from '../src/types';

/**
 * S4 negative controls – the shapes that must NOT become delimiter tables.
 *
 * Prose full of commas, a key:value config, a log file and a Markdown table all
 * have their own reader. Each is asserted with its strategy, columns and row
 * count, and then re-run under a `.csv` name to prove the extension does not
 * change the reading.
 */

const CASES: { name: string; text: string; strategy: string; columns: string[]; rows: number }[] = [
  {
    name: 'prose with commas',
    strategy: 'Plain text',
    columns: ['text'],
    rows: 4,
    text: [
      'The quarterly review covered three sites, two regions and one new product line.',
      'Sales in the north, which had lagged since spring, recovered after the promotion.',
      'Costs rose in June, fell again in July, and were flat through the rest of the quarter.',
      'The team agreed, after a long discussion, to keep the current pricing, for now.',
    ].join('\n\n'),
  },
  {
    name: 'key:value config',
    strategy: 'key:value pairs',
    columns: ['name', 'port', 'debug', 'retries', 'timeout'],
    rows: 1,
    text: ['# app settings', 'name: converter', 'port: 8080', 'debug: false', 'retries: 3', 'timeout: 30'].join('\n'),
  },
  {
    name: 'log file',
    strategy: 'Log lines',
    columns: ['timestamp', 'level', 'message'],
    rows: 4,
    text: [
      '2025-05-01 12:00:01 INFO starting worker',
      '2025-05-01 12:00:02 WARN cache cold, warming up',
      '2025-05-01 12:00:05 ERROR request failed, retrying',
      '2025-05-01 12:00:06 INFO done, 3 items',
    ].join('\n'),
  },
  {
    name: 'Markdown table',
    strategy: 'Markdown table',
    columns: ['region', 'q1', 'q2'],
    rows: 2,
    text: [
      '# Report',
      '',
      '| Region | Q1 | Q2 |',
      '|--------|----|----|',
      '| North | 1200 | 1450 |',
      '| South | 980 | 1025 |',
    ].join('\n'),
  },
];

async function convert(name: string, text: string): Promise<Dataset> {
  const bytes = new TextEncoder().encode(text);
  const [dataset] = await processBytes(name, name.endsWith('.csv') ? 'text/csv' : 'text/plain', bytes, {});
  return dataset;
}

describe('S4 – text shapes keep their own reader', () => {
  for (const testCase of CASES) {
    it(`${testCase.name} still reads as "${testCase.strategy}"`, async () => {
      const ds = await convert('shape.txt', testCase.text);
      expect(ds.report.strategy).toBe(testCase.strategy);
      expect(ds.columns).toEqual(testCase.columns);
      expect(ds.rows.length).toBe(testCase.rows);
      expect(ds.report.rejectedCount).toBe(0);
    });

    it(`${testCase.name} reads the same when named .csv`, async () => {
      const asText = await convert('shape.txt', testCase.text);
      const asCsv = await convert('shape.csv', testCase.text);
      expect(asCsv.report.strategy).toBe(testCase.strategy);
      expect(toCSV(asCsv.columns, asCsv.rows)).toBe(toCSV(asText.columns, asText.rows));
    });
  }

  it('does not turn a sentence with commas into columns', async () => {
    const ds = await convert(
      'note.txt',
      'Dear team, the report, which covers Q1 and Q2, is attached, and the totals, as agreed, are provisional.',
    );
    expect(ds.columns).toEqual(['text']);
    expect(ds.rows.length).toBe(1);
  });
});
