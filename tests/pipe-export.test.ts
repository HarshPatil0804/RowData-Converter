import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { processBytes } from '../src/pipeline/index';
import { toCSV } from '../src/lib/export';
import { SAMPLES_DIR } from './helpers';
import type { Cell, Dataset } from '../src/types';

/**
 * S4 + S5 regression – the pipe export a user dropped on the live site.
 *
 * The file is a real export shape, not a synthetic CSV: a banner, an export
 * date and `,,,` padding lines wrapped around a six-row pipe table, an error
 * line in the middle, a control total at the end, packed `key=value` details,
 * mixed date formats, currency, a null sentinel and a composite column that
 * joins its halves with ` - ` in some rows and ` / ` in others.
 *
 * Expected values are derived BY HAND from the file, as an auditor would, not
 * snapshotted from the app: the ids 1001–1006, the six dates, the amounts and
 * their sum (which equals the file's own TOTAL line), the name/age/city parts,
 * and the region/status halves.
 */

const SAMPLE = 'pipe_sales_export.txt';

function readSampleBytes(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(SAMPLES_DIR, name)));
}

async function convert(name: string, mime: string, bytes?: Uint8Array): Promise<Dataset> {
  const [dataset] = await processBytes(name, mime, bytes ?? readSampleBytes(SAMPLE), {});
  return dataset;
}

function column(dataset: Dataset, name: string): Cell[] {
  const index = dataset.columns.indexOf(name);
  if (index < 0) throw new Error(`column ${name} missing from ${dataset.columns.join(', ')}`);
  return dataset.rows.map((row) => row[index]);
}

describe('S4 – a pipe export inside comma padding', () => {
  it('reads the pipe table, not the padding', async () => {
    const ds = await convert(SAMPLE, 'text/plain');
    expect(ds.report.strategy).toContain('delimiter "|"');
  });

  it('keeps six clean rows with ids 1001–1006 (the # prefix removed)', async () => {
    const ds = await convert(SAMPLE, 'text/plain');
    expect(ds.rows.length).toBe(6);
    expect(column(ds, 'order_id')).toEqual([1001, 1002, 1003, 1004, 1005, 1006]);
    // The untouched value stays reachable, as R2 promises.
    expect(column(ds, 'order_id_raw')).toEqual(['#1001', '1002', '#1003', '1004', '1005', '#1006']);
  });

  it('resolves each date from the order its own pattern proves', async () => {
    const ds = await convert(SAMPLE, 'text/plain');
    expect(column(ds, 'trans_date')).toEqual([
      '2025-10-12', // 10/12/2025 – the slash pattern is proved month-first by 10/17/2025
      '2025-10-13',
      '2025-10-14', // Oct 14 2025
      '2025-10-15', // 15-10-2025 – the dash pattern is proved day-first
      '2025-10-16',
      '2025-10-17',
    ]);
    expect(ds.report.ambiguousDates).toBe(0);
  });

  it('reads the amounts, keeps N/A as a null with a note, and reconciles the TOTAL line', async () => {
    const ds = await convert(SAMPLE, 'text/plain');
    expect(column(ds, 'amount_usd')).toEqual([1250.5, 850, null, 2100.75, 450, 1250.5]);

    // The null is accounted for, never invented and never lost.
    const notes = ds.report.notes.join('\n');
    expect(notes).toMatch(/column "amount_usd": 1 missing value\(s\) left as null/);

    const reconciliation = ds.report.reconciliation;
    expect(reconciliation).not.toBeNull();
    expect(reconciliation?.column).toBe('amount_usd');
    expect(reconciliation?.parsed).toBe(5901.75);
    expect(reconciliation?.reported).toBe(5901.75);
    expect(reconciliation?.matches).toBe(true);
  });

  it('splits the packed customer details into name, age and city', async () => {
    const ds = await convert(SAMPLE, 'text/plain');
    expect(column(ds, 'name')).toEqual(['John Doe', 'Alice Smith', 'Bob Lee', 'Claire', 'John Doe', 'David K']);
    expect(column(ds, 'age')).toEqual([34, null, 29, null, 34, null]);
    expect(column(ds, 'city')).toEqual(['New York', 'London', 'Tokyo', 'Paris', 'New York', 'New York']);
  });

  it('splits the composite column even though its separator changes per row (S5)', async () => {
    const ds = await convert(SAMPLE, 'text/plain');
    expect(column(ds, 'region')).toEqual(['North', 'Europe', 'Asia', 'Europe', 'North', 'North']);
    // "completed" and "COMPLETED" are one category after R6.
    expect(column(ds, 'status')).toEqual([
      'COMPLETED',
      'COMPLETED',
      'PENDING',
      'COMPLETED',
      'CANCELLED',
      'COMPLETED',
    ]);
  });

  it('rejects every non-table line with a reason instead of guessing a column', async () => {
    const ds = await convert(SAMPLE, 'text/plain');
    const blob = ds.rejected.map((row) => `${row.reason}: ${row.values.filter((v) => v !== null).join(' ')}`).join('\n');

    expect(blob).toContain('RAW EXPORT - SYSTEM LOGS & SALES DATA - CONFIDENTIAL');
    expect(blob).toContain('Export Date: 2026-10-24');
    expect(blob).toContain('ERR_ROW_9999_SKIPPED_SYSTEM_CORRUPT');
    expect(blob).toContain('TOTAL SALES CALCULATED: $5901.75');

    const reasons = ds.report.rejectedReasons;
    expect(reasons.find((entry) => entry.reason === 'title line')?.count).toBe(1);
    expect(reasons.find((entry) => entry.reason === 'export metadata line')?.count).toBe(1);
    expect(reasons.find((entry) => entry.reason === 'blank row')?.count).toBe(2);
    expect(reasons.find((entry) => entry.reason === 'error row')?.count).toBe(1);
    expect(reasons.find((entry) => entry.reason === 'summary/total line')?.count).toBe(1);

    // Every line of the file is accounted for: clean + rejected (+ duplicates).
    expect(ds.report.rejectedCount).toBe(ds.rejected.length);
    expect(ds.report.rowsIn).toBe(
      ds.report.rowsOut + ds.report.rejectedCount + ds.report.duplicatesRemoved,
    );
  });
});

describe('S4 – the extension never decides the strategy', () => {
  const bytes = readSampleBytes(SAMPLE);
  // Same bytes, five names: two the reader used to treat as "CSV", one as TSV,
  // one as text and one with no extension at all.
  const names: [string, string][] = [
    ['pipe_sales_export.txt', 'text/plain'],
    ['pipe_sales_export.csv', 'text/csv'],
    ['pipe_sales_export.tsv', 'text/tab-separated-values'],
    ['pipe_sales_export.dat', 'application/octet-stream'],
    ['pipe_sales_export', 'application/octet-stream'],
  ];

  it('produces byte-identical cleaned tables and reports for all five names', async () => {
    const outputs: { name: string; csv: string }[] = [];
    for (const [name, mime] of names) {
      const ds = await convert(name, mime, bytes);
      outputs.push({ name, csv: toCSV(ds.columns, ds.rows) });
    }
    const first = outputs[0] as { name: string; csv: string };
    for (const output of outputs.slice(1)) {
      expect(output.csv, `${output.name} differs from ${first.name}`).toBe(first.csv);
    }
    // And the shared output is the hand-derived table, not an empty one.
    expect(first.csv.trimEnd().split('\n').length).toBe(7); // header + 6 rows
    expect(first.csv).toContain('2025-10-12');
  });
});
