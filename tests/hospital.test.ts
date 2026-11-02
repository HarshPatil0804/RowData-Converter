import { describe, expect, it } from 'vitest';
import { runSample, runText } from './helpers';
import { computePivot, flaggedShares, verifyPivot } from '../src/lib/pivot';
import { pivotToMatrix, pivotToSheets, datasetToSheets, qualityToTable } from '../src/lib/export';
import type { Cell, Dataset, PivotConfig } from '../src/types';

/**
 * Acceptance tests for the hospital sample — the real, messy export in
 * samples/hospital/raw.csv. Every assertion is a generic pipeline rule
 * (R1–R10 / P1–P9) observed through this one file: no hospital column name is
 * ever special-cased in src/.
 */

const FEE = 4668696.06;

let cached: Dataset | undefined;
async function hospital(): Promise<Dataset> {
  if (!cached) [cached] = await runSample('hospital/raw.csv');
  return cached;
}

const idx = (ds: Dataset, name: string): number => ds.columns.indexOf(name);
const values = (ds: Dataset, name: string): (string | number | boolean | null)[] =>
  ds.rows.map((row) => row[idx(ds, name)]);
const distinct = (ds: Dataset, name: string): Set<string> =>
  new Set(values(ds, name).filter((v) => v !== null && v !== '').map(String));

function rowById(ds: Dataset, id: number): (string | number | boolean | null)[] {
  const i = idx(ds, 'visit_id');
  const row = ds.rows.find((r) => r[i] === id);
  if (!row) throw new Error(`visit_id ${id} not found`);
  return row;
}

const PIVOT_CONFIG: PivotConfig = {
  rows: ['visit_status'],
  cols: ['visit_type'],
  value: 'fee_inr',
  agg: 'sum',
};

// ------------------------------------------------------------- clean stage --

describe('R1 junk rows', () => {
  it('keeps 999 clean rows and moves every junk line to Rejected rows with a reason', async () => {
    const ds = await hospital();
    expect(ds.rows.length).toBe(999);
    expect(ds.report.rowsOut).toBe(999);

    const rejected = ds.rejected;
    const blob = rejected.map((r) => `${r.reason}: ${r.values.join(' ')}`).join('\n');

    expect(blob).toContain('ERR_VISIT'); // error row
    expect(blob).toContain('SYSTEM ALERT'); // error row
    expect(blob).toMatch(/title line/i); // title line
    expect(blob).toContain('2026-10-27'); // export date + export generated
    expect(blob).toContain('Export Date'); // export-date line
    expect(blob).toContain('Export generated'); // summary footer line
    expect(blob).toMatch(/TOTAL VISIT FEES/); // control total

    // Every rejection carries a reason — nothing is dropped silently.
    for (const row of rejected) expect(row.reason.length).toBeGreaterThan(0);
    expect(ds.report.rejectedCount).toBe(rejected.length);
    // 7 junk lines + the blank line 3 of the fixture: blank rows are rejected
    // with a reason now, never deleted at parse time.
    expect(ds.report.rejectedCount).toBe(8);

    const reasons = ds.report.rejectedReasons.map((r) => r.reason);
    expect(reasons).toContain('title line');
    expect(reasons).toContain('export metadata line');
    expect(reasons).toContain('error row');
    expect(reasons).toContain('summary/total line');
    expect(reasons).toContain('blank row');
  });
});

describe('R2 ids', () => {
  it('strips prefixes, # and spaces from the id and keeps the original', async () => {
    const ds = await hospital();
    const idIdx = idx(ds, 'visit_id');
    const rawIdx = idx(ds, 'visit_id_raw');
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(rawIdx).toBeGreaterThanOrEqual(0);
    expect(ds.types[idIdx]).toBe('number');

    for (const row of ds.rows) {
      const id = row[idIdx];
      expect(typeof id).toBe('number');
      expect(Number.isInteger(id as number)).toBe(true);
    }
    // The untouched original survives, prefixes and all.
    const raws = values(ds, 'visit_id_raw').map(String);
    expect(raws.some((v) => v.includes('#'))).toBe(true);
    expect(raws.some((v) => v.includes('VIS-'))).toBe(true);
    expect(raws.some((v) => /^\D/.test(v.trim()))).toBe(true);
    // and the cleaned id never carries that noise back
    for (const id of values(ds, 'visit_id').map(String)) {
      expect(id).not.toMatch(/[a-zA-Z#\s]/);
    }

    // And the cleaned id really is the same person's id.
    expect(rowById(ds, 70031)[idIdx]).toBe(70031);
  });
});

describe('R3 dates', () => {
  it('reads dash dates as MM-DD-YYYY and slash dates as DD/MM/YYYY', async () => {
    const ds = await hospital();
    const dateIdx = idx(ds, 'visit_date');
    expect(ds.types[dateIdx]).toBe('date');

    const iso = (id: number): string => String(rowById(ds, id)[dateIdx]);
    expect(iso(70031)).toBe('2025-02-12'); // 02-12-2025  → Feb 12 (23 > 11 proves MM-DD)
    expect(iso(70149)).toBe('2026-09-12'); // 09-12-2026  → Sep 12
    expect(iso(70027)).toBe('2026-02-06'); // 06/02/2026  → Feb 6 (slash stays DD/MM)

    // every date is a real ISO day
    for (const value of values(ds, 'visit_date')) {
      if (value === null || value === '') continue;
      expect(String(value)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('flags no future dates after the fix and reports the ambiguous count', async () => {
    const ds = await hospital();
    const future = ds.report.flagCounts.find((f) => f.name === 'date_future');
    expect(future?.count ?? 0).toBe(0);
    expect(ds.report.ambiguousDates).toBe(0);
    // the export date is the reference clock
    expect(ds.report.exportDate).toBe('2026-10-27');
  });
});

describe('R4 numbers', () => {
  it('keeps fee_inr numeric-or-null with the text parked in fee_inr_note', async () => {
    const ds = await hospital();
    const feeIdx = idx(ds, 'fee_inr');
    expect(ds.types[feeIdx]).toBe('number');

    let numeric = 0;
    let nulls = 0;
    for (const row of ds.rows) {
      const value = row[feeIdx];
      if (value === null || value === '') nulls += 1;
      else {
        expect(typeof value).toBe('number');
        expect(Number.isFinite(value as number)).toBe(true);
        numeric += 1;
      }
    }
    expect(numeric).toBe(751);
    expect(nulls).toBe(248);

    // "N/A", "pending", "insurance pending" never survive inside the number
    const noteIdx = idx(ds, 'fee_inr_note');
    expect(noteIdx).toBeGreaterThan(0);
    expect(values(ds, 'fee_inr_note').filter((v) => v === 'insurance pending').length).toBe(29);

    // blanks stay blank (null), non-numeric text is explained in the note
    const noteValues = values(ds, 'fee_inr_note');
    expect(noteValues.filter((v) => v !== null).length).toBe(29);
  });
});

describe('R5 packed fields', () => {
  it('splits patient details and department/procedure into their own columns', async () => {
    const ds = await hospital();
    for (const name of ['patient_name', 'age', 'city', 'department', 'procedure']) {
      expect(ds.columns).toContain(name);
    }
    expect(values(ds, 'age').filter((v) => v === null).length).toBe(184);
    // the packed source cells are gone
    for (const row of ds.rows) {
      const patient = String(row[idx(ds, 'patient_name')] ?? '');
      expect(patient).not.toContain('age=');
      expect(patient).not.toContain('city=');
      const department = String(row[idx(ds, 'department')] ?? '');
      expect(department).not.toContain(' / ');
      expect(department).not.toContain(' - ');
    }
  });
});

describe('R6 categories', () => {
  it('clusters variants into the expected cardinalities with canonical casing', async () => {
    const ds = await hospital();
    expect(distinct(ds, 'city').size).toBe(15);
    expect(distinct(ds, 'department').size).toBe(8);

    const combos = new Set(
      ds.rows.map((row) => `${row[idx(ds, 'department')]}|${row[idx(ds, 'procedure')]}`),
    );
    expect(combos.size).toBeLessThanOrEqual(32);

    const statuses = distinct(ds, 'visit_status');
    expect(statuses.size).toBe(6);
    for (const status of statuses) expect(status).toBe(status.toUpperCase());

    const payments = distinct(ds, 'payment_status');
    expect(payments.size).toBe(5);
    for (const status of payments) expect(status).toBe(status.toUpperCase());

    // cities are Title Case
    for (const city of distinct(ds, 'city')) expect(city).toBe(city[0].toUpperCase() + city.slice(1));

    // the before → after mapping is preserved for the report
    expect(ds.report.mappings.length).toBeGreaterThan(0);
    expect(ds.report.mappings[0]).toHaveProperty('from');
    expect(ds.report.mappings[0]).toHaveProperty('to');
  });
});

describe('R7 placeholders and system notes', () => {
  it('removes "no extra notes" and parks system text in system_flag', async () => {
    const ds = await hospital();
    const notesIdx = idx(ds, 'notes');
    for (const row of ds.rows) {
      const note = String(row[notesIdx] ?? '').toLowerCase();
      expect(note).not.toContain('no extra notes');
      expect(note).not.toMatch(/^n\/?a$/);
      expect(note).not.toBe('-');
    }
    const sysIdx = idx(ds, 'system_flag');
    expect(sysIdx).toBeGreaterThan(0);
    expect(values(ds, 'system_flag').filter((v) => v === true).length).toBe(27);
    // no system text left in the human notes column
    for (const row of ds.rows) {
      expect(String(row[notesIdx] ?? '')).not.toMatch(/^SYSTEM (NOTE|ALERT)/i);
    }
  });
});

describe('R8 duplicates', () => {
  it('drops exact duplicates and reports them', async () => {
    const ds = await hospital();
    expect(ds.report.duplicatesRemoved).toBe(2);
    const seen = new Set<string>();
    for (const row of ds.rows) {
      const key = JSON.stringify(row);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    const conflict = ds.report.flagCounts.find((f) => f.name === 'duplicate_id_conflict');
    expect(conflict?.count ?? 0).toBe(0);
  });
});

describe('R9 logic flags', () => {
  it('flags fee_on_cancelled_or_noshow without deleting anything', async () => {
    const ds = await hospital();
    const flagIdx = idx(ds, 'fee_on_cancelled_or_noshow');
    expect(flagIdx).toBeGreaterThan(0);
    expect(values(ds, 'fee_on_cancelled_or_noshow').filter((v) => v === true).length).toBe(228);
    expect(ds.report.rowsOut).toBe(999);

    // the flag is derived, not hardcoded: verify it against status + fee
    const statusIdx = idx(ds, 'visit_status');
    const feeIdx = idx(ds, 'fee_inr');
    const derived = ds.rows.filter((row) => {
      const status = String(row[statusIdx]);
      return (status === 'CANCELLED' || status === 'NO_SHOW') && typeof row[feeIdx] === 'number';
    }).length;
    expect(derived).toBe(228);

    const counts = new Map(ds.report.flagCounts.map((f) => [f.name, f.count]));
    expect(counts.get('fee_on_cancelled_or_noshow')).toBe(228);
    expect(counts.get('age_missing')).toBe(184);
    expect(counts.get('system_flag')).toBe(27);
  });
});

describe('R10 reconciliation', () => {
  it('shows parsed vs reported fee totals and the difference', async () => {
    const ds = await hospital();
    const recon = ds.report.reconciliation;
    expect(recon).not.toBeNull();
    expect(recon!.column).toBe('fee_inr');
    expect(recon!.parsed).toBeCloseTo(4668696.06, 2);
    expect(recon!.reported).toBe(4287650);
    expect(recon!.difference).toBeCloseTo(381046.06, 2);
    expect(recon!.matches).toBe(false);

    // the report table carries the same numbers
    const table = qualityToTable(ds.report);
    const cell = (section: string, key: string): Cell | undefined =>
      table.rows.find((row) => row[0] === section && row[1] === key)?.[2];
    expect(cell('summary', 'rows_in')).toBe(1009);
    expect(cell('summary', 'rows_out')).toBe(999);
    expect(cell('summary', 'rejected_rows')).toBe(8);
    expect(cell('summary', 'ambiguous_dates')).toBe(0);
    expect(cell('reconciliation', 'parsed')).toBe(4668696.06);
    expect(cell('reconciliation', 'reported')).toBe(4287650);
    expect(cell('reconciliation', 'difference')).toBe(381046.06);
    expect(cell('column', 'fee_inr.nulls')).toBe(248);
    expect(cell('column', 'fee_inr.conversions')).toBeGreaterThan(0);
    expect(cell('flag', 'fee_on_cancelled_or_noshow')).toBe(228);
  });
});

// ---------------------------------------------------------------- pivot ----

describe('P1/P2 pivot build', () => {
  it('builds a split-free pivot from the cleaned data', async () => {
    const ds = await hospital();
    const pivot = computePivot(ds, { ...PIVOT_CONFIG });

    expect(pivot.rowLabels.length).toBe(6);
    expect(pivot.columns.length).toBe(5);
    expect(pivot.cells.flat().length).toBe(30);
    for (const cell of pivot.cells.flat()) expect(cell).not.toBeNull();

    const rowLabels = pivot.rowLabels.map((labels) => labels[0]);
    expect(new Set(rowLabels).size).toBe(6);
    for (const label of rowLabels) expect(label).toBe(label.toUpperCase());
    expect(rowLabels).toEqual(
      ['CANCELLED', 'COMPLETED', 'IN_PROGRESS', 'NO_SHOW', 'REFERRED', 'SCHEDULED'],
    );

    // P1: the pivot reads the final clean dataset, so grand total = report sum
    expect(pivot.grandTotal).toBeCloseTo(FEE, 2);
    expect(pivot.totalRows).toBe(999);
    expect(verifyPivot(pivot).ok).toBe(true);
  });

  it('P2 – never splits a category that differs only by case/space/punctuation', async () => {
    const csv = [
      'region,amount',
      'Paid,10',
      'PAID,20',
      ' paid ,30',
      'PAID.,5',
      'P-a-i-d,2',
    ].join('\n');
    const [ds] = await runText('split.csv', csv);
    const pivot = computePivot(ds, { rows: ['region'], cols: [], value: 'amount', agg: 'sum' });
    // exactly one axis value: the five spellings collapsed into a single row
    expect(pivot.rowLabels.length).toBe(1);
    expect(pivot.rowLabels[0][0].toLowerCase().replace(/[^a-z]/g, '')).toBe('paid');
    expect(pivot.grandTotal).toBe(67);
    expect(pivot.cells[0].reduce<number>((acc, v) => acc + (v ?? 0), 0)).toBe(67);
  });

  it('P9 – suggests two sensible defaults with categorical axes and a numeric value', async () => {
    const { suggestPivots } = await import('../src/lib/pivot');
    const ds = await hospital();
    const suggestions = suggestPivots(ds);
    expect(suggestions.length).toBeGreaterThanOrEqual(2);
    for (const suggestion of suggestions) {
      expect(suggestion.rows.length).toBeGreaterThan(0);
      expect(suggestion.value).toBeTruthy();
      expect(ds.types[ds.columns.indexOf(suggestion.value)]).toBe('number');
      for (const field of [...suggestion.rows, ...suggestion.cols]) {
        const cardinality = distinct(ds, field).size;
        expect(cardinality).toBeGreaterThanOrEqual(3);
        expect(cardinality).toBeLessThanOrEqual(12);
      }
    }
  });
});

describe('P3/P4 empty vs zero and hidden rows', () => {
  it('leaves empty cells empty, keeps 0 for real zero sums, and reports hidden rows', async () => {
    const csv = [
      'a,b,v',
      'x,p,0',
      'x,q,5',
    ].join('\n');
    const [ds] = await runText('empty.csv', csv);
    const pivot = computePivot(ds, { rows: ['a'], cols: ['b'], value: 'v', agg: 'sum' });
    // exactly one cell (x × p) has records and sums to 0 → must be 0, not empty
    expect(pivot.cells[0][0]).toBe(0);
    expect(pivot.cells[0][1]).toBe(5);

    const empty = pivotToMatrix(pivot, { showZero: false });
    expect(empty.rows[0][1]).toBe(0); // real zero stays 0

    const ds2 = await hospital();
    const hospitalPivot = computePivot(ds2, { ...PIVOT_CONFIG });
    expect(hospitalPivot.rowsWithoutValue).toBe(248);
    expect(hospitalPivot.totalRows).toBe(999);

    // P4 – Sum + Count: the count pivot's grand total is the number of rows
    // that carry a value
    const countPivot = computePivot(ds2, { rows: ['visit_status'], cols: ['visit_type'], value: 'fee_inr', agg: 'count' });
    expect(countPivot.grandTotal).toBe(751);

    // matrix keeps empty cells empty when showZero is off
    const matrix = pivotToMatrix(hospitalPivot, { showZero: false });
    const flat = matrix.rows.flat();
    expect(flat.filter((cell) => cell === null).length).toBe(0); // this pivot is fully dense
  });
});

describe('P5 totals', () => {
  it('labels both totals "Total", verifies every total, and blocks on failure', async () => {
    const ds = await hospital();
    const pivot = computePivot(ds, { ...PIVOT_CONFIG });
    const matrix = pivotToMatrix(pivot, { includeTotals: true });

    expect(matrix.columns.at(-1)).toBe('Total');
    const lastRow = matrix.rows.at(-1)!;
    expect(lastRow[0]).toBe('Total');

    // every row total = sum of its cells, every column total likewise
    pivot.rowTotals.forEach((total, rowIndex) => {
      const sum = pivot.cells[rowIndex].reduce<number>((acc, v) => acc + (v ?? 0), 0);
      expect(total).toBeCloseTo(sum, 6);
    });
    pivot.colTotals.forEach((total, colIndex) => {
      const sum = pivot.cells.reduce<number>((acc, row) => acc + (row[colIndex] ?? 0), 0);
      expect(total).toBeCloseTo(sum, 6);
    });
    expect(pivot.grandTotal).toBeCloseTo(FEE, 2);
    expect(verifyPivot(pivot)).toEqual({ ok: true, failures: [] });

    // includeTotals: false drops both
    const bare = pivotToMatrix(pivot, { includeTotals: false });
    expect(bare.columns.at(-1)).not.toBe('Total');
    expect(bare.rows.at(-1)![0]).not.toBe('Total');

    // a genuinely broken table must not verify
    const broken = verifyPivot({ ...pivot, grandTotal: 1 });
    expect(broken.ok).toBe(false);
    expect(broken.failures.some((failure) => failure.includes('grand total'))).toBe(true);
  });
});

describe('P6 flagged-row share', () => {
  it('reports the fee_on_cancelled_or_noshow share and rebuilds without it', async () => {
    const ds = await hospital();
    const shares = flaggedShares(ds, { ...PIVOT_CONFIG });
    const feeShare = shares.find((s) => s.flag === 'fee_on_cancelled_or_noshow');
    expect(feeShare).toBeTruthy();
    expect(feeShare!.share).toBeCloseTo(0.313, 3);

    const filtered = computePivot(ds, { ...PIVOT_CONFIG }, { excludeFlag: 'fee_on_cancelled_or_noshow' });
    expect(filtered.excludedFlag).toBe('fee_on_cancelled_or_noshow');
    expect(filtered.grandTotal).toBeCloseTo(3206869.46, 2);
    expect(filtered.rowsExcludedFlagged).toBe(228);
    expect(verifyPivot(filtered).ok).toBe(true);
  });
});

describe('P7/P8 export', () => {
  it('writes plain 2-decimal numbers and a Pivot info sheet with every P8 field', async () => {
    const ds = await hospital();
    const pivot = computePivot(ds, { ...PIVOT_CONFIG });
    const matrix = pivotToMatrix(pivot, { includeTotals: true });

    for (const row of matrix.rows) {
      for (const cell of row) {
        if (typeof cell !== 'number') continue;
        expect(cell).toBe(Math.round(cell * 100) / 100);
        expect(Number.isFinite(cell)).toBe(true);
      }
    }
    expect(JSON.stringify(matrix)).not.toContain('₹');
    expect(JSON.stringify(matrix)).not.toContain('INR');
    expect(JSON.stringify(matrix)).not.toContain('Rs.');

    const sheets = pivotToSheets(ds, pivot, { includeTotals: true });
    expect(sheets.map((s) => s.name)).toEqual(['Pivot', 'Pivot info']);
    const info = sheets[1];
    const infoMap = new Map(info.rows.map((row) => [String(row[0]), row[1]]));
    for (const field of [
      'source file',
      'row field',
      'column field',
      'value field',
      'aggregation',
      'filters applied',
      'rows used',
      'rows excluded (null value)',
      'rows excluded (flagged)',
      'reconciliation result',
    ]) {
      expect(infoMap.has(field)).toBe(true);
    }
    expect(infoMap.get('row field')).toBe('visit_status');
    expect(infoMap.get('column field')).toBe('visit_type');
    expect(infoMap.get('value field')).toBe('fee_inr');
    expect(infoMap.get('aggregation')).toBe('sum');
    expect(infoMap.get('rows excluded (null value)')).toBe(248);
    expect(String(infoMap.get('reconciliation result'))).toContain('4287650');

    // total cells are flagged as totals, not ordinary values
    const pivotSheet = sheets[0];
    expect(pivotSheet.totalCells!.length).toBeGreaterThan(0);
  });

  it('tabular workbook is multi-sheet (clean / rejected / report / mappings)', async () => {
    const ds = await hospital();
    const sheets = datasetToSheets(ds);
    expect(sheets.map((s) => s.name)).toEqual([
      'Clean data',
      'Rejected rows',
      'Quality report',
      'Value mappings',
    ]);
    expect(sheets[0].rows.length).toBe(999);
    expect(sheets[1].rows.length).toBe(8);
    expect(sheets[3].rows.length).toBeGreaterThan(0);
  });
});
