// @vitest-environment node
/**
 * Spreadsheet-safe export.
 *
 * The threat: a CSV is data, but Excel/LibreOffice/Sheets treat a cell starting
 * with `=`, `+`, `-` or `@` as a formula. A file that was "just" a table then
 * executes code on the machine that opens the download.
 *
 * The contract proven here:
 *   - text columns: such a cell is exported with a leading apostrophe;
 *   - numeric and date columns: never touched, so -5 stays a number;
 *   - the toggle can turn the prefix off;
 *   - XLSX writes text as a string cell, never a formula, with no toggle at all;
 *   - the report counts neutralised cells.
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { countFormulaLike, isFormulaLike, toCSV, workbookFromSheets } from '../src/lib/export';
import type { Cell, ColumnType } from '../src/types';

const HYPERLINK_PAYLOAD = '=HYPERLINK("https://evil.example","y")';
const DDE_PAYLOAD = "=cmd|' /C calc'!A0";
const PAYLOADS = [
  DDE_PAYLOAD,
  '@SUM(1+1)',
  '+1+1',
  '-2+3',
  '\t=1+1',
  // Last: this one contains commas, so it cannot be read back with split(',').
  HYPERLINK_PAYLOAD,
  '\r=1+1',
];

describe('CSV export is formula-safe', () => {
  const types: ColumnType[] = ['text', 'number', 'date', 'text'];
  // One payload per row in the text column, so the column type is unambiguous.
  const payloadRows: Cell[][] = PAYLOADS.slice(0, 6).map((payload, index) => [
    payload,
    -5 + index,
    '2024-01-02',
    'plain',
  ]);

  const csv = toCSV(['a', 'b', 'c', 'd'], payloadRows, { types, spreadsheetSafe: true });
  /** A cell that contains no comma, so a plain split is exact. */
  const cell = (row: number, column: number): string =>
    csv.replace(/^\uFEFF/, '').trim().split('\r\n')[row + 1].split(',')[column];

  it('prefixes formula-like text cells with an apostrophe', () => {
    expect(cell(0, 0)).toContain("'=cmd|' /C calc'!A0");
    expect(cell(1, 0)).toBe("'@SUM(1+1)");
    expect(cell(2, 0)).toBe("'+1+1");
    expect(cell(3, 0)).toBe("'-2+3");
    // The HYPERLINK payload contains commas, so match it in the file text.
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example"",""y"")"`);
  });

  it('never rewrites numbers or dates', () => {
    // The numeric column holds negatives down to -5; the date column ISO dates.
    expect(cell(0, 1)).toBe('-5');
    expect(cell(4, 1)).toBe('-1');
    expect(cell(0, 2)).toBe('2024-01-02');
  });

  it('keeps ordinary text untouched', () => {
    const csv = toCSV(['a'], [['plain text']], { types: ['text'], spreadsheetSafe: true });
    expect(csv.replace(/^\uFEFF/, '').trim().split('\r\n')[1]).toBe('plain text');
  });

  it('honours the toggle', () => {
    const csv = toCSV(['a'], [['=1+1']], { types: ['text'], spreadsheetSafe: false });
    expect(csv.replace(/^\uFEFF/, '').trim().split('\r\n')[1]).toBe('=1+1');
  });

  it('treats every cell as text when no types are supplied, but spares real numbers', () => {
    // Pivot matrices pass no types because their columns mix labels and totals.
    const csv = toCSV(['a', 'b', 'c'], [['-2+3', '-42', 42]], { spreadsheetSafe: true });
    const line = csv.replace(/^\uFEFF/, '').trim().split('\r\n')[1];
    expect(line).toBe("'-2+3,-42,42");
  });

  it('counts what it neutralised', () => {
    expect(countFormulaLike([['=1', 'x', '@y']], ['text', 'text', 'number'])).toBe(1);
    expect(countFormulaLike([['=1', 'x', '@y']], ['text', 'text', 'text'])).toBe(2);
    expect(countFormulaLike([['-1']], ['number'])).toBe(0);
    for (const payload of PAYLOADS) expect(isFormulaLike(payload)).toBe(true);
    expect(isFormulaLike('plain')).toBe(false);
  });
});

describe('XLSX export never writes a formula', () => {
  const rewritten = (text: string): string => text;
  const columns = ['payload', 'amount', 'note'];
  const rows: Cell[][] = [
    ['=HYPERLINK("https://evil.example","y")', -5, 'plain'],
    ["=cmd|' /C calc'!A0", 12.5, 'plain'],
    ['@SUM(1+1)', -0.5, 'plain'],
    ['+1+1', 7, 'plain'],
    ['-2+3', 8, 'plain'],
  ].map((row) => row.map((cell) => (typeof cell === 'string' ? rewritten(cell) : cell)));

  const bytes = workbookFromSheets([{ name: 'Data', columns, rows }]);
  const workbook = XLSX.read(bytes, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  it('stores text payloads as string cells with no formula', () => {
    rows.forEach((row, index) => {
      const address = XLSX.utils.encode_cell({ r: index + 1, c: 0 });
      const cell = sheet[address] as XLSX.CellObject | undefined;
      expect(cell, address).toBeDefined();
      expect(cell?.t, `${address} type`).toBe('s');
      expect(cell?.f, `${address} formula`).toBeUndefined();
      expect(cell?.v).toBe(row[0]);
    });
  });

  it('keeps numeric cells numeric, including negatives', () => {
    const numbers = [0, 1, 2, 3, 4].map((index) =>
      sheet[XLSX.utils.encode_cell({ r: index + 1, c: 1 })] as XLSX.CellObject,
    );
    expect(numbers.map((cell) => cell.t)).toEqual(['n', 'n', 'n', 'n', 'n']);
    expect(numbers.map((cell) => cell.v)).toEqual([-5, 12.5, -0.5, 7, 8]);
    expect(numbers.every((cell) => cell.f === undefined)).toBe(true);
  });
});
