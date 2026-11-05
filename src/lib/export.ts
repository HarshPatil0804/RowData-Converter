import * as XLSX from 'xlsx';
import type { Cell, ColumnType, Dataset, QualityReport, RejectedRow } from '../types';
import { displayCell } from './strings';
import { isFormulaLike } from './formula';
import { splitItems } from '../pipeline/rules';
import type { PivotTable } from './pivot';

export { isFormulaLike, countFormulaLike } from './formula';

export interface CsvOptions {
  /** Column types, index-aligned. Only `text` columns are neutralised. */
  types?: ColumnType[];
  /** Default true. When false the CSV is byte-identical to the data. */
  spreadsheetSafe?: boolean;
}

/** A value a spreadsheet reads as a number, not as a formula. */
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

/** RFC-4180 CSV with BOM (so Excel opens UTF-8 correctly). */
export function toCSV(columns: string[], rows: Cell[][], options: CsvOptions = {}): string {
  const escape = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const safe = options.spreadsheetSafe ?? true;
  const types = options.types;
  const neutralise = (cell: Cell, column: number): string => {
    const text = displayCell(cell);
    if (!safe) return text;
    // A declared non-text column is never altered: -5 stays -5.
    if (types) {
      if (types[column] !== 'text') return text;
    } else if (typeof cell === 'number' || PLAIN_NUMBER.test(text.trim())) {
      // No declared types (pivot matrices): a real total, including a negative
      // one, is left exactly as written; only text that looks like a formula is
      // neutralised.
      return text;
    }
    return isFormulaLike(text) ? `'${text}` : text;
  };
  const lines: string[] = [columns.map(escape).join(',')];
  for (const row of rows) {
    lines.push(row.map((cell, column) => escape(neutralise(cell, column))).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function toJSON(columns: string[], rows: Cell[][]): string {
  const records = rows.map((row) => {
    const record: Record<string, Cell> = {};
    columns.forEach((name, index) => {
      record[name] = row[index] ?? null;
    });
    return record;
  });
  return `${JSON.stringify(records, null, 2)}\n`;
}

/**
 * A filename that cannot lie about where it came from.
 *
 * Path separators are removed (no directory traversal in a download), control
 * characters, bidi overrides and zero-width joiners are stripped (so
 * "invoice\u202Ecod.exe" cannot be displayed as "invoicedoc.exe"), characters
 * Windows rejects become `_`, and the result is length-capped.
 */
export function safeDownloadName(name: string): string {
  const base = typeof name === 'string' && name !== '' ? name : 'download';
  const withoutPath = base.split(/[\\/]/).pop() ?? 'download';
  const cleaned = withoutPath
    .normalize('NFKC')
    // C0/C1 controls, bidi embedding/override/isolate, zero-width characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  const capped = cleaned.slice(0, 100).replace(/[.\s]+$/, '');
  return capped === '' ? 'download' : capped;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeDownloadName(fileName);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text: string, fileName: string, mime: string): void {
  downloadBlob(new Blob([text], { type: mime }), fileName);
}

export function downloadCSV(columns: string[], rows: Cell[][], fileName: string, options: CsvOptions = {}): void {
  downloadText(toCSV(columns, rows, options), fileName, 'text/csv;charset=utf-8');
}

export function downloadJSON(columns: string[], rows: Cell[][], fileName: string): void {
  downloadText(toJSON(columns, rows), fileName, 'application/json');
}

export interface SheetSpec {
  name: string;
  columns: string[];
  rows: Cell[][];
  /**
   * P5 – cells that hold a pivot total (total row / total column). They are
   * written with a "total" cell comment so a consumer can tell them apart from
   * ordinary category values instead of summing them twice.
   */
  totalCells?: { r: number; c: number }[];
}

/** SheetJS total cells: flagged with a comment (styles are CE read-only). */
const TOTAL_COMMENT = 'total';

export function workbookFromSheets(sheets: SheetSpec[]): Uint8Array<ArrayBuffer> {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const aoa = [sheet.columns, ...sheet.rows];
    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    worksheet['!cols'] = sheet.columns.map((name, index) => {
      let width = name.length + 2;
      for (let i = 0; i < Math.min(sheet.rows.length, 200); i += 1) {
        width = Math.max(width, displayCell(sheet.rows[i][index]).length + 2);
      }
      return { wch: Math.min(width, 60) };
    });
    // +1: row 0 of the sheet is the header row.
    for (const { r, c } of sheet.totalCells ?? []) {
      const address = XLSX.utils.encode_cell({ r: r + 1, c });
      const cell = worksheet[address];
      if (!cell) continue;
      cell.c = [{ a: 'u2s', t: TOTAL_COMMENT }];
    }
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name.slice(0, 31) || 'Sheet1');
  }
  // SheetJS returns an ArrayBuffer for type:'array' — Uint8Array.from() on an
  // ArrayBuffer silently yields 0 bytes, so unwrap it explicitly.
  const written = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer | ArrayLike<number>;
  return written instanceof ArrayBuffer ? new Uint8Array(written) : Uint8Array.from(written);
}

export function downloadXLSX(sheets: SheetSpec[], fileName: string): void {
  const out = workbookFromSheets(sheets);
  downloadBlob(
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    fileName,
  );
}

// ------------------------------------------------------- tabular sheets ----

/** P7 – CSV/XLSX numbers: plain, no currency, rounded to 2 decimals. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** R1 – rejected rows as a table: reason + one column per source position. */
export function rejectedToTable(rejected: RejectedRow[]): { columns: string[]; rows: Cell[][] } {
  const width = rejected.reduce((max, row) => Math.max(max, row.values.length), 0);
  const columns = ['reason', ...Array.from({ length: width }, (_unused, index) => `value_${index + 1}`)];
  const rows = rejected.map((row) => {
    const cells: Cell[] = [...row.values];
    while (cells.length < width) cells.push(null);
    return [row.reason, ...cells];
  });
  return { columns, rows };
}

/** Quality report as section/key/value rows (shared by CSV and XLSX). */
export function qualityToTable(report: QualityReport): { columns: string[]; rows: Cell[][] } {
  const rows: Cell[][] = [];
  const push = (section: string, key: string, value: string | number): void => {
    rows.push([section, key, value]);
  };

  push('summary', 'file', report.fileName);
  push('summary', 'source_type', report.sourceType);
  push('summary', 'strategy', report.strategy);
  push('summary', 'rows_in', report.rowsIn);
  push('summary', 'rows_out', report.rowsOut);
  push('summary', 'columns_in', report.columnsIn);
  push('summary', 'columns_out', report.columnsOut);
  push('summary', 'rejected_rows', report.rejectedCount);
  push('summary', 'duplicates_removed', report.duplicatesRemoved);
  push('summary', 'empty_rows_dropped', report.emptyRowsDropped);
  push('summary', 'empty_columns_dropped', report.emptyColumnsDropped);
  push('summary', 'nulls_fixed', report.nullsFixed);
  push('summary', 'values_filled', report.valuesFilled);
  push('summary', 'outliers_flagged', report.outliersFlagged);
  push('summary', 'ambiguous_dates', report.ambiguousDates);
  push('summary', 'header_detected', report.headerDetected ? 'yes' : 'no');
  push('summary', 'spreadsheet_safe_cells', report.spreadsheetSafeCells);

  for (const column of report.columns) {
    const key = (suffix: string): string => `${column.name}.${suffix}`;
    push('column', key('type'), column.type);
    push('column', key('nulls'), column.nulls);
    push('column', key('filled'), column.filled);
    push('column', key('unique'), column.unique);
    push('column', key('outliers'), column.outliers);
    push('column', key('conversions'), column.conversions);
    push('column', key('examples'), column.examples.map((example) => displayCell(example)).join(' | '));
  }

  for (const flag of report.flagCounts) push('flag', flag.name, flag.count);

  for (const reason of report.rejectedReasons) push('rejected', reason.reason, reason.count);

  if (report.reconciliation) {
    const { column, parsed, reported, difference, matches } = report.reconciliation;
    push('reconciliation', 'column', column);
    push('reconciliation', 'parsed', parsed);
    push('reconciliation', 'reported', reported ?? 'none');
    push('reconciliation', 'difference', difference ?? 'n/a');
    push('reconciliation', 'matches', matches === null ? 'unverifiable' : matches ? 'yes' : 'no');
  }

  if (report.rowControl) {
    push('row_control', 'reported', report.rowControl.reported);
    push('row_control', 'actual', report.rowControl.actual);
    push('row_control', 'matches', report.rowControl.matches ? 'yes' : 'no');
    push('row_control', 'source', report.rowControl.source);
  }

  push('summary', 'spelled_numbers', report.spelledNumbers);
  push('summary', 'review_items', report.reviewItems.length);
  push('summary', 'low_confidence', report.reviewItems.filter((item) => item.confidence < 0.8).length);

  for (const rule of report.rulesFired) push('rule', rule, 'fired');

  for (const item of report.reviewItems) {
    push('review', item.id, `${item.applied ? 'applied' : 'pending'} · conf ${item.confidence} · ${item.original || '(empty)'} → ${item.suggested}`);
  }

  for (const entry of report.overlapping) {
    push('overlap', entry.column, `${entry.value} = ${entry.parts.join(' + ')}`);
  }

  if (report.files.length > 1) {
    for (const file of report.files) {
      const key = (suffix: string): string => `${file.fileName}.${suffix}`;
      push('file', key('source_type'), file.sourceType);
      push('file', key('rows_in'), file.rowsIn);
      push('file', key('rows_out'), file.rowsOut);
      push('file', key('duplicates_removed'), file.duplicatesRemoved);
    }
  }

  for (const note of report.notes) push('note', '', note);

  return { columns: ['section', 'key', 'value'], rows };
}

/**
 * R17 – explode multi-item cells: one output row per item on a *second*
 * sheet. The clean sheet itself never changes; the toggle defaults to off.
 */
function explodeDataset(dataset: Dataset): SheetSpec | null {
  const countColumns = dataset.columns
    .map((name, index) => ({ name, index }))
    .filter(({ name, index }) => name.endsWith('_item_count') && dataset.types[index] === 'number');
  if (countColumns.length === 0) return null;

  let rows: Cell[][] = dataset.rows;
  for (const { name, index } of countColumns) {
    const sourceName = name.slice(0, -'_item_count'.length);
    const sourceIndex = dataset.columns.indexOf(sourceName);
    if (sourceIndex < 0) continue;
    const next: Cell[][] = [];
    for (const row of rows) {
      const value = row[sourceIndex];
      const count = row[index];
      if (typeof value !== 'string' || typeof count !== 'number' || count <= 1) {
        next.push(row);
        continue;
      }
      for (const item of splitItems(value)) {
        const copy = [...row];
        copy[sourceIndex] = item;
        copy[index] = 1;
        next.push(copy);
      }
    }
    rows = next;
  }
  return { name: 'Exploded data', columns: dataset.columns, rows };
}

export interface DatasetSheetOptions {
  /** R17 – add an "Exploded data" sheet with one row per item (default off). */
  explode?: boolean;
}

/**
 * Tabular workbook – P8 multi-sheet: Clean data, Rejected rows,
 * Quality report, Value mappings (+ "Exploded data" when R17's toggle is on).
 */
export function datasetToSheets(dataset: Dataset, options: DatasetSheetOptions = {}): SheetSpec[] {
  const rejected = rejectedToTable(dataset.rejected);
  const quality = qualityToTable(dataset.report);
  const mappings: SheetSpec = {
    name: 'Value mappings',
    columns: ['column', 'from', 'to', 'count'],
    rows: dataset.report.mappings.map((mapping) => [mapping.column, mapping.from, mapping.to, mapping.count]),
  };
  const sheets: SheetSpec[] = [
    { name: 'Clean data', columns: dataset.columns, rows: dataset.rows },
    { name: 'Rejected rows', columns: rejected.columns, rows: rejected.rows },
    { name: 'Quality report', columns: quality.columns, rows: quality.rows },
    mappings,
  ];
  if (options.explode) {
    const exploded = explodeDataset(dataset);
    if (exploded) sheets.push(exploded);
  }
  return sheets;
}

// ------------------------------------------------------------ pivot export --

export interface PivotMatrixOptions {
  /** P5 – include the Total row and Total column (CSV option, default on). */
  includeTotals?: boolean;
  /** P3 – show 0 instead of an empty cell (display/export, default off). */
  showZero?: boolean;
}

/**
 * Flatten a pivot table into a plain matrix (header + body + totals).
 *
 * P5 – the total row and the total column both carry the single label
 * "Total", so nothing in the file pretends to be a category value.
 * P7 – every number is rounded to 2 decimals and never carries a currency
 * symbol; P3 – empty cells stay empty unless `showZero` is set.
 */
export function pivotToMatrix(
  pivot: PivotTable,
  options: PivotMatrixOptions = {},
): { columns: string[]; rows: Cell[][] } {
  const { includeTotals = true, showZero = false } = options;
  const cell = (value: number | null | undefined): number | null => {
    if (value === null || value === undefined || !Number.isFinite(value)) return showZero ? 0 : null;
    return round2(value);
  };

  const header = [...pivot.rowFields, ...pivot.columns, ...(includeTotals ? ['Total'] : [])];
  const rows: Cell[][] = pivot.rowLabels.map((labels, rowIndex) => {
    const body = (pivot.cells[rowIndex] ?? []).map((value) => cell(value));
    const row: Cell[] = [...labels, ...body];
    if (includeTotals) row.push(cell(pivot.rowTotals[rowIndex]));
    return row;
  });

  if (includeTotals) {
    const totalRow: Cell[] = [
      ...pivot.rowFields.map((_field, index) => (index === 0 ? 'Total' : '')),
      ...pivot.colTotals.map((value) => cell(value)),
      cell(pivot.grandTotal),
    ];
    rows.push(totalRow);
  }

  return { columns: header, rows };
}

/**
 * P5/P8 – pivot workbook: the "Pivot" sheet (totals flagged as total cells)
 * plus a "Pivot info" sheet describing how the pivot was built.
 */
export function pivotToSheets(
  dataset: Dataset,
  pivot: PivotTable,
  options: PivotMatrixOptions = {},
): SheetSpec[] {
  const matrix = pivotToMatrix(pivot, options);
  const totalCells: { r: number; c: number }[] = [];
  if (options.includeTotals !== false) {
    const totalRow = matrix.rows.length - 1;
    const totalCol = matrix.columns.length - 1;
    for (let c = 0; c <= totalCol; c += 1) totalCells.push({ r: totalRow, c });
    for (let r = 0; r <= totalRow; r += 1) totalCells.push({ r, c: totalCol });
  }

  const info = pivotInfoTable(dataset, pivot);
  return [
    { name: 'Pivot', columns: matrix.columns, rows: matrix.rows, totalCells },
    { name: 'Pivot info', columns: info.columns, rows: info.rows },
  ];
}

/** P8 – everything needed to audit how the pivot was produced. */
export function pivotInfoTable(
  dataset: Dataset,
  pivot: PivotTable,
): { columns: string[]; rows: Cell[][] } {
  const rowsUsed = Math.max(0, dataset.rows.length - pivot.rowsExcludedFlagged - pivot.rowsWithoutValue);
  const recon = dataset.report.reconciliation;
  const reconText = !recon
    ? 'no reconciliation available'
    : recon.reported === null
      ? `${recon.column}: parsed ${recon.parsed} (file declares no total)`
      : `${recon.column}: parsed ${recon.parsed} vs reported ${recon.reported} → difference ${recon.difference}`;

  const info: [string, string | number][] = [
    ['source file', dataset.report.fileName],
    ['row field', pivot.rowFields.join(', ') || '(none)'],
    ['column field', pivot.colFields.join(', ') || '(none)'],
    ['value field', pivot.valueField || '(row count)'],
    ['aggregation', pivot.agg],
    ['filters applied', pivot.excludedFlag ? `exclude flagged rows: ${pivot.excludedFlag}` : 'none'],
    ['rows used', rowsUsed],
    ['rows excluded (null value)', pivot.rowsWithoutValue],
    ['rows excluded (flagged)', pivot.rowsExcludedFlagged],
    ['reconciliation result', reconText],
  ];
  return { columns: ['field', 'value'], rows: info.map(([field, value]) => [field, value]) };
}

// ------------------------------------------------------- quality report ----

/**
 * Quality report as CSV. Every row uses the same three columns
 * (section, key, value) so the file parses as one consistent table.
 */
export function qualityToCSV(report: QualityReport): string {
  const table = qualityToTable(report);
  const esc = (value: string | number): string =>
    /[",\r\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
  const lines = [table.columns.join(',')];
  for (const row of table.rows) lines.push(row.map((cell) => esc(displayCell(cell))).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function qualityToJSON(report: QualityReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
