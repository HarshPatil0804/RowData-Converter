import type {
  Cell,
  ColumnMeta,
  ColumnType,
  Dataset,
  FileReport,
  OverlapEntry,
  QualityReport,
  RawTable,
  RejectedRow,
  ReviewItem,
  ValueMapping,
} from '../types';
import { cellKey, categoryKey, cleanText, displayCell, isNullSentinel, standardizeNames } from '../lib/strings';
import { hasCurrencySign, hasPercentSign, parseNumberValue } from '../lib/numbers';
import {
  excelSerialToIso,
  looksLikeDate,
  resolveDates,
  type DateOrderMode,
  type DayMonthOrder,
} from '../lib/dates';
import {
  DEFAULT_TUNING,
  booleanFamily,
  decideType,
  planEmails,
  planFractions,
  isSerialText,
  planNumeric,
  planPhones,
  toBooleanCell,
  type Tuning,
  type TuningOverride,
} from './typing';
import { generatedNames, padRows } from '../lib/table';
import { countFormulaLike } from '../lib/formula';
import { findExportDate, findRowControl, rejectReasons, rejectRows, type HeaderMode } from './reject';
import { splitColumn } from './packed';
import { isIdColumn, isMissingIdColumn, normalizeIdColumn, planMissingIds } from './ids';
import {
  buildLogicFlags,
  clearSystemCells,
  convertNumeric,
  detectSystemRows,
  findOverlaps,
  findReportedTotal,
  isCategoryColumn,
  normalizeCategories,
  planItems,
  reconcile,
} from './rules';

const BOOL_TRUE = /^(true|yes)$/i;
const BOOL_FALSE = /^(false|no)$/i;
const SAMPLE_LIMIT = 1000;
/** A value already written as an ISO date/datetime. */
const ISO_VALUE_RE = /^\d{4}-\d{2}-\d{2}(?:$|[T ])/;

export interface CleanOptions {
  /**
   * R3 – how to treat date patterns the file never proves:
   * 'auto' (default) keeps the original value and files a review suggestion;
   * 'DM'/'MD' is the explicit toggle choice and applies that order.
   */
  dateOrder?: DateOrderMode;
  /** Review items the user accepted – their suggestion is applied on re-run. */
  acceptReviews?: readonly string[];
  /**
   * Typing thresholds. Not a UI control: the fuzz harness sweeps four values
   * per threshold to show the rules do not depend on one of them.
   */
  tuning?: TuningOverride;
}

/** A leading "+" means phone/reference-like text – keep it, never coerce. */
function numericText(value: string): boolean {
  if (value.trimStart().startsWith('+')) return false;
  return parseNumberValue(value) !== null;
}

function sampleOf<T>(values: T[]): T[] {
  if (values.length <= SAMPLE_LIMIT) return values;
  const step = values.length / SAMPLE_LIMIT;
  const out: T[] = [];
  for (let i = 0; i < SAMPLE_LIMIT; i += 1) out.push(values[Math.floor(i * step)]);
  return out;
}

function inferType(values: Cell[], tuning: Tuning = DEFAULT_TUNING): ColumnType {
  const present = values.filter((value) => value !== null);
  if (present.length === 0) return 'text';
  if (present.every((value) => typeof value === 'boolean')) return 'boolean';

  if (present.every((value) => typeof value === 'string')) {
    const sample = sampleOf(present as string[]);
    const booleans = sample.filter((value) => BOOL_TRUE.test(value) || BOOL_FALSE.test(value)).length;
    if (booleans / sample.length >= tuning.booleanMajority) return 'boolean';
    const numbers = sample.filter((value) => numericText(value)).length;
    if (numbers / sample.length >= tuning.numericMajority) return 'number';
    const dates = sample.filter((value) => looksLikeDate(value)).length;
    // Excel serials are date evidence too (T3), but only alongside real dates:
    // a column of nothing but five-digit numbers is an id or an amount, never a
    // date column.
    const serials = dates > 0 ? sample.filter((value) => isSerialText(value)).length : 0;
    if ((dates + serials) / sample.length >= tuning.dateMajority) return 'date';
    return 'text';
  }

  if (present.every((value) => typeof value === 'number')) return 'number';
  return 'text';
}

interface Conversion {
  values: Cell[];
  notes: string[];
}

function convertColumn(values: Cell[], type: ColumnType): Conversion {
  const notes: string[] = [];
  if (type === 'number') {
    let currency = 0;
    let percent = 0;
    const out = values.map((value) => {
      if (value === null || typeof value === 'number') return value;
      if (typeof value === 'boolean') return value ? 1 : 0;
      const parsed = numericText(value) ? parseNumberValue(value) : null;
      if (parsed !== null) {
        if (hasCurrencySign(value)) currency += 1;
        if (hasPercentSign(value)) percent += 1;
        return parsed;
      }
      // R4: never leave text behind in a numeric column.
      return null;
    });
    if (currency > 0) notes.push(`${currency} currency value(s) normalised to numbers`);
    if (percent > 0) notes.push(`${percent} percent value(s) normalised to plain numbers`);
    return { values: out, notes };
  }

  if (type === 'boolean') {
    // Every vocabulary family (y/n, yes/no, true/false, t/f, 1/0, on/off) has
    // the same canonical form, so the column does not expose which one it used.
    const out = values.map((value) => toBooleanCell(value));
    return { values: out, notes };
  }

  return { values, notes };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  const next = sorted[base + 1];
  return next !== undefined ? sorted[base] + rest * (next - sorted[base]) : sorted[base];
}

function modeOf(values: Cell[]): Cell | null {
  const counts = new Map<string, { value: Cell; count: number }>();
  for (const value of values) {
    if (value === null) continue;
    const key = cellKey(value);
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { value, count: 1 });
  }
  let best: { value: Cell; count: number } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best ? best.value : null;
}

/** Rebuild the column list after one column expanded into several. */
interface Expansion {
  names: string[];
  force: boolean[];
  conv: number[];
  columns: Cell[][];
}

function rebuild(
  columns: string[],
  force: boolean[],
  conv: number[],
  rows: Cell[][],
  expand: (index: number, name: string, values: Cell[]) => Expansion | null,
): { columns: string[]; force: boolean[]; conv: number[]; rows: Cell[][]; added: string[] } {
  const nextNames: string[] = [];
  const nextForce: boolean[] = [];
  const nextConv: number[] = [];
  const nextRows: Cell[][] = rows.map(() => []);
  const added: string[] = [];

  columns.forEach((name, index) => {
    const values = rows.map((row) => row[index]);
    const expansion = expand(index, name, values);
    if (!expansion) {
      nextNames.push(name);
      nextForce.push(force[index] ?? false);
      nextConv.push(conv[index] ?? 0);
      values.forEach((value, rowIndex) => nextRows[rowIndex].push(value));
      return;
    }
    expansion.names.forEach((splitName, position) => {
      if (position > 0) added.push(splitName);
      nextNames.push(splitName);
      nextForce.push(expansion.force[position] ?? false);
      nextConv.push(expansion.conv[position] ?? 0);
      expansion.columns[position].forEach((value, rowIndex) => nextRows[rowIndex].push(value));
    });
  });

  return { columns: nextNames, force: nextForce, conv: nextConv, rows: nextRows, added };
}

/** Append one boolean flag column. */
function appendFlag(
  state: { columns: string[]; force: boolean[]; conv: number[]; types: ColumnType[]; rows: Cell[][] },
  name: string,
  values: Cell[],
): void {
  state.columns.push(name);
  state.force.push(false);
  state.conv.push(0);
  state.types.push('boolean');
  state.rows.forEach((row, index) => row.push(values[index] ?? null));
}

/**
 * Clean stage: R1 reject → header → normalise → R5 packed split → sentinels →
 * R2 ids → R7 system flag → R3 dates → R4 numbers → R6 categories → types →
 * R8 de-duplicate → R9 logic flags → R10 reconciliation → report.
 */
export function cleanTable(
  raw: RawTable,
  fileName: string,
  sourceType: string,
  options: CleanOptions = {},
): Dataset {
  const dateOrder: DateOrderMode = options.dateOrder ?? 'auto';
  const tuning: Tuning = { ...DEFAULT_TUNING, ...(options.tuning ?? {}) };
  const parseRates: { column: string; parsed: number; total: number; rate: number }[] = [];
  const conversions: { column: string; kind: string; count: number }[] = [];
  const accepted = new Set(options.acceptReviews ?? []);
  const reviewItems: ReviewItem[] = [];
  const fired = new Set<string>();
  const notes = [...raw.notes];
  const cleanNotes: string[] = [];

  // ---- 1. R1: reject junk rows and locate the header ---------------------
  const columnsKnown = raw.columns.length > 0;
  const mode: HeaderMode = columnsKnown
    ? 'no'
    : raw.hasHeader === true
      ? 'yes'
      : raw.hasHeader === false
        ? 'no'
        : 'auto';
  const scan = rejectRows(raw.rows, mode, columnsKnown);
  // S4 – lines the reader refused before R1 saw them (banner, export date,
  // delimiter padding, error / summary / footer lines) join the rejected table,
  // so the row accounting stays exact: rows_in = clean + rejected + duplicates.
  const readerRejected = raw.rejectedRows ?? [];
  scan.rejected.push(...readerRejected);
  if (scan.rejected.length > 0) fired.add('R1');
  if (scan.rejected.some((row) => row.reason.startsWith('footer'))) fired.add('R11');

  let columns: string[];
  let rows: Cell[][];
  let headerDetected: boolean;
  let generated: string[] = [];

  if (columnsKnown) {
    columns = raw.columns.map((name) => cleanText(String(name)).trim());
    rows = scan.kept.map((row) => [...row]);
    headerDetected = raw.hasHeader !== false;
  } else if (scan.headerIndex >= 0) {
    const headerRow = scan.kept[scan.headerIndex];
    columns = headerRow.map((cell, index) =>
      cell === null || cell === undefined || `${cell}`.trim() === '' ? `col_${index + 1}` : `${cell}`,
    );
    rows = scan.kept.filter((_row, index) => index !== scan.headerIndex).map((row) => [...row]);
    headerDetected = true;
    cleanNotes.push('header row detected and used as column names');
  } else {
    const first = scan.kept[0] ?? [];
    columns = generatedNames(first.length);
    generated = [...columns];
    rows = scan.kept.map((row) => [...row]);
    headerDetected = false;
    cleanNotes.push('no header row found – generated column names');
  }

  const rejected: RejectedRow[] = scan.rejected;
  const headerConsumed = !columnsKnown && scan.headerIndex >= 0 ? 1 : 0;
  const rowsIn = raw.rows.length + readerRejected.length - headerConsumed;

  if (rows.length === 0) {
    throw new Error(rowsIn === 0 ? 'No data rows could be produced from this file' : 'All rows were empty after cleaning');
  }

  rows = padRows(rows, columns.length);

  // ---- 1b. S3: a header repeated mid-file (page break) is not a data row ---
  if (headerDetected) {
    const headerKey = columns.map((name) => cleanText(String(name)).trim().toLowerCase().replace(/\s+/g, ' '));
    const repeats: Cell[][] = [];
    rows = rows.filter((row) => {
      const isRepeat =
        row.length === headerKey.length &&
        row.every((cell, position) => {
          const text = cell === null || cell === undefined ? '' : cleanText(String(cell)).trim().toLowerCase().replace(/\s+/g, ' ');
          return text === headerKey[position];
        });
      if (isRepeat) repeats.push(row);
      return !isRepeat;
    });
    if (repeats.length > 0) {
      rejected.push(...repeats.map((values) => ({ reason: 'repeated header', values })));
      fired.add('S3');
      cleanNotes.push(`${repeats.length} repeated header row(s) rejected (S3 – page break, not data)`);
    }
  }

  // ---- 2. R12: unicode / decorative quotes / trim – FIRST, before any
  //          matching, clustering or type inference sees the value ----------
  let quotesStripped = 0;
  const r12Clean = (matrix: Cell[][]): Cell[][] =>
    matrix.map((row) =>
      row.map((cell) => {
        if (cell === null || cell === undefined) return null;
        if (typeof cell === 'string') {
          const trimmed = cleanText(cell).trim();
          if (trimmed !== cell && /^\s*["'].*["']\s*$/.test(cell)) quotesStripped += 1;
          return trimmed === '' ? null : trimmed;
        }
        if (typeof cell === 'number' && !Number.isFinite(cell)) return null;
        return cell;
      }),
    );
  rows = r12Clean(rows);
  if (quotesStripped > 0) {
    fired.add('R12');
    cleanNotes.push(`R12: decorative wrapping quotes stripped from ${quotesStripped} value(s)`);
  }

  let force = columns.map(() => false);
  let conv = columns.map(() => 0);

  // ---- 3. R5/R16: split packed fields -----------------------------------
  const before = columns.length;
  const packed = rebuild(columns, force, conv, rows, (_index, name, values) => {
    const split = splitColumn(name, values);
    if (!split) return null;
    fired.add(split.kind === 'paren' ? 'R16' : 'R5');
    return {
      names: split.names,
      force: split.names.map(() => split.kind === 'pair'),
      conv: split.names.map(() => 0),
      columns: split.columns,
    };
  });
  if (packed.columns.length > before) {
    cleanNotes.push(`packed column(s) split into ${packed.columns.length} fields (R5/R16)`);
  }
  columns = packed.columns;
  force = packed.force;
  conv = packed.conv;
  rows = packed.rows;
  // R12 again: the split produced fresh cells out of packed text, so their
  // decorative quotes/whitespace must be stripped before any matching,
  // clustering or type inference sees them.
  rows = r12Clean(rows);

  // ---- 4. sentinels → null ----------------------------------------------
  let nullsFixed = 0;
  rows = rows.map((row) =>
    row.map((cell) => {
      if (typeof cell === 'string' && isNullSentinel(cell)) {
        nullsFixed += 1;
        return null;
      }
      return cell;
    }),
  );

  // ---- 5. empty rows → Rejected (never lost silently) ---------------------
  const beforeRows = rows.length;
  const emptied: Cell[][] = [];
  rows = rows.filter((row) => {
    if (row.some((cell) => !isNullSentinel(cell))) return true;
    emptied.push(row);
    return false;
  });
  const emptyRowsDropped = beforeRows - rows.length;
  if (emptied.length > 0) {
    // These rows carried only sentinels after cleaning – keep the accounting
    // honest (rows_in = clean + rejected + duplicates) by rejecting them too.
    rejected.push(...emptied.map((values) => ({ reason: 'blank row (all values missing)', values })));
  }
  if (rows.length === 0) throw new Error('All rows were empty after cleaning');

  // ---- 6. standardise column names (snake_case) --------------------------
  const standardised = standardizeNames(columns);
  const renamed = standardised.filter((name, index) => name !== columns[index]).length;
  if (renamed > 0) cleanNotes.push(`${renamed} column name(s) normalised to snake_case`);
  columns = standardised;

  // ---- 7. R2: identifier columns ----------------------------------------
  const idColumns: string[] = [];
  const idRebuilt = rebuild(columns, force, conv, rows, (index, name, values) => {
    if (!isIdColumn(name, values)) return null;
    const result = normalizeIdColumn(values);
    if (result.normalised === 0) return null;
    fired.add('R2');
    idColumns.push(name);
    cleanNotes.push(
      `column "${name}": ${result.normalised} identifier(s) normalised to a core key (original kept in ${name}_raw)`,
    );
    const names = [name, `${name}_raw`];
    const columnsOut: Cell[][] = [result.core, result.raw];
    const forceOut = [force[index] ?? false, false];
    const convOut = [conv[index] ?? 0, 0];
    if (result.hasTags) {
      names.push(`${name}_tag`);
      columnsOut.push(result.tag);
      forceOut.push(false);
      convOut.push(0);
    }
    return { names, force: forceOut, conv: convOut, columns: columnsOut };
  });
  columns = idRebuilt.columns;
  force = idRebuilt.force;
  conv = idRebuilt.conv;
  rows = idRebuilt.rows;

  // ---- 7b. R14: id columns with gaps keep their rows ---------------------
  if (!columns.includes('missing_id')) {
    const candidate = columns.findIndex(
      (name, index) =>
        !name.endsWith('_raw') && !name.endsWith('_tag') && !name.endsWith('_note') && isMissingIdColumn(rows.map((row) => row[index])),
    );
    if (candidate >= 0) {
      const plan = planMissingIds(rows.map((row) => row[candidate]));
      if (plan.count > 0) {
        fired.add('R14');
        columns.push('generated_id', 'missing_id');
        force.push(false, false);
        conv.push(0, 0);
        rows.forEach((row, index) => {
          row.push(plan.generated[index]);
          row.push(plan.missing[index] ? true : null);
        });
        cleanNotes.push(
          `column "${columns[candidate]}": ${plan.count} row(s) have no id – generated_id assigned, rows kept (R14)`,
        );
        reviewItems.push({
          id: `missing_id:${columns[candidate]}`,
          kind: 'missing_id',
          column: columns[candidate],
          rowIndex: null,
          original: '',
          suggested: 'generated_id',
          confidence: 0.7,
          reason: `${plan.count} row(s) have no id; generated_id was added and missing_id flags them – rows are never merged or dropped`,
          applied: true,
        });
      }
    }
  }

  // ---- 8. R7: system-generated notes ------------------------------------
  const systemRows = detectSystemRows(columns, rows);
  const systemCount = clearSystemCells(columns, rows, systemRows);
  const hasSystem = systemRows.some(Boolean);
  if (hasSystem) {
    fired.add('R7');
    columns.push('system_flag');
    force.push(false);
    conv.push(0);
    rows.forEach((row, index) => row.push(systemRows[index] ? true : null));
    cleanNotes.push(`${systemCount} system-generated note(s) moved to system_flag (R7)`);
  }

  // ---- 9. export date (reference for R3 future / R9 scheduled) -----------
  const exportDate = findExportDate(rejected);

  // ---- 10. provisional types (content only: family, fraction, date, number) --
  let types: ColumnType[] = columns.map((_name, index) =>
    decideType(
      rows.map((row) => row[index]),
      tuning,
    ).type,
  );

  // ---- 11. R3: dates with a proven per-pattern day/month order -----------
  let ambiguousDates = 0;
  const ambiguousRows: boolean[] = new Array<boolean>(rows.length).fill(false);
  const dateIndices: number[] = [];
  const dateOrderSuggestions = new Map<string, { column: string; example: string; iso: string | null }>();

  for (let index = 0; index < columns.length; index += 1) {
    if (types[index] !== 'date') continue;
    dateIndices.push(index);
    const columnValues = rows.map((row) => row[index]);
    // Effective mode: the toggle wins; otherwise an accepted suggestion
    // converts this column; 'auto' keeps originals and files the suggestion.
    const reviewId = `date_order:${columns[index]}`;
    const acceptedHere = dateOrder === 'auto' && accepted.has(reviewId);
    const effective: DateOrderMode = dateOrder !== 'auto' ? dateOrder : acceptedHere ? 'DM' : 'auto';
    const resolved = resolveDates(columnValues, effective);
    resolved.values.forEach((iso, rowIndex) => {
      rows[rowIndex][index] = iso;
    });
    for (const position of resolved.ambiguousIndices) {
      ambiguousRows[position] = true;
      // One review item per column (pattern detail lives in the reason).
      if (!dateOrderSuggestions.has(columns[index])) {
        const original = String(columnValues[position] ?? '');
        const suggestionMode: DayMonthOrder = effective === 'auto' ? 'DM' : effective;
        const suggested = resolveDates([original], suggestionMode).values[0] ?? original;
        dateOrderSuggestions.set(columns[index], {
          column: columns[index],
          example: original,
          iso: typeof suggested === 'string' ? suggested : original,
        });
      }
    }
    ambiguousDates += resolved.ambiguousIndices.length;
    // T3(a) – Excel serials left behind by the date resolver (it only knows
    // date shapes, and a 5-digit number has none). Only in a column that is
    // already a date column, so a column of ids or amounts never qualifies.
    let serials = 0;
    rows.forEach((row) => {
      const value = row[index];
      const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
      if (!/^\d{5}(?:\.\d+)?$/.test(text)) return;
      const serial = Number(text);
      if (serial < 20000 || serial > 80000) return;
      const iso = excelSerialToIso(serial);
      if (!iso) return;
      row[index] = iso;
      serials += 1;
    });
    if (serials > 0) {
      conversions.push({ column: columns[index], kind: 'Excel serial (1900 system)', count: serials });
      cleanNotes.push(
        `column "${columns[index]}": ${serials} Excel serial number(s) converted to ISO dates and flagged (T3)`,
      );
      reviewItems.push({
        id: `serial_dates:${columns[index]}`,
        kind: 'serial_dates',
        column: columns[index],
        rowIndex: null,
        original: 'Excel serial',
        suggested: 'ISO date',
        confidence: 0.85,
        reason: `${serials} value(s) were Excel serial numbers in a date column; they were converted with the 1900 leap-year offset`,
        applied: true,
      });
    }
    conv[index] = resolved.converted + serials;
    if (resolved.converted > 0) {
      fired.add('R3');
      cleanNotes.push(`column "${columns[index]}": ${resolved.converted} date(s) normalised to ISO 8601 (R3)`);
    }
    if (resolved.ambiguousIndices.length > 0) {
      fired.add('R3');
      cleanNotes.push(
        `column "${columns[index]}": ${resolved.ambiguousIndices.length} day/month value(s) whose order the file never proves – original kept and flagged, suggestion in Needs review (R3)`,
      );
    }
    types[index] = inferType(rows.map((row) => row[index]));
  }

  for (const [column, info] of dateOrderSuggestions) {
    const id = `date_order:${column}`;
    const applied = dateOrder !== 'auto' || accepted.has(id);
    reviewItems.push({
      id,
      kind: 'date_order',
      column,
      rowIndex: null,
      original: info.example,
      suggested: info.iso ?? info.example,
      confidence: 0.5,
      reason:
        dateOrder === 'auto'
          ? 'day/month order is unproven for this format pattern – accepting reads these values as YYYY-MM-DD shown, rejecting keeps them as written'
          : 'day/month order is unproven for this format pattern; the current toggle order was applied',
      applied,
    });
  }

  if (ambiguousDates > 0 && !columns.includes('date_ambiguous')) {
    columns.push('date_ambiguous');
    force.push(false);
    conv.push(0);
    types.push('boolean');
    rows.forEach((row, index) => row.push(ambiguousRows[index] ? true : null));
  }

  if (exportDate && dateIndices.length > 0) {
    // Only ISO values can be compared as dates – kept originals must not be
    // lexicographically compared against the export date.
    const futureRows = rows.map((row) =>
      dateIndices.some(
        (index) =>
          typeof row[index] === 'string' && ISO_VALUE_RE.test(row[index] as string) && (row[index] as string) > exportDate,
      ),
    );
    if (futureRows.some(Boolean) && !columns.includes('date_future')) {
      columns.push('date_future');
      force.push(false);
      conv.push(0);
      types.push('boolean');
      rows.forEach((row, index) => row.push(futureRows[index] ? true : null));
      cleanNotes.push(
        `column "date_future": ${futureRows.filter(Boolean).length} row(s) dated after the file's export date ${exportDate} (R3)`,
      );
    }
  }

  // ---- 11c. T4: score fractions ("18/20") ------------------------------
  const fractionRebuilt = rebuild(columns, force, conv, rows, (index, name, values) => {
    if (types[index] !== 'number' || name.endsWith('_note')) return null;
    const plan = planFractions(values, tuning);
    if (!plan || plan.converted === 0) return null;
    fired.add('T4');
    conversions.push({ column: name, kind: `score fraction /${plan.denominator}`, count: plan.converted });
    cleanNotes.push(
      `column "${name}": ${plan.converted} score fraction(s) converted to the numerator, denominator ${plan.denominator} (T4)`,
    );
    return {
      names: [name, `${name}_note`],
      force: [false, false],
      conv: [plan.converted, 0],
      columns: [plan.values, plan.notes],
    };
  });
  columns = fractionRebuilt.columns;
  force = fractionRebuilt.force;
  conv = fractionRebuilt.conv;
  rows = fractionRebuilt.rows;
  types = columns.map((_name, index) => inferType(rows.map((row) => row[index]), tuning));

  // ---- 12. R4/T1/T2/T5: numbers, with the text moved to <col>_note -------
  // Tolerant typing: a column whose values are mostly numbers is a number
  // column even when a minority of cells are not, and each cell is parsed on
  // its own (currency, "/-", period suffixes, discovered units, magnitudes,
  // placeholders). The original text of every cell that does not parse is
  // kept in <col>_note.
  let spelledNumbers = 0;
  const numericFlags = columns.map((_name, index) => {
    // A note column holds the originals a rule could not parse: it stays text.
    if (_name.endsWith('_note')) return false;
    if (types[index] === 'number') return true;
    const values = rows.map((row) => row[index]);
    const decision = decideType(values, tuning);
    return decision.type === 'number';
  });
  const numericRebuilt = rebuild(columns, force, conv, rows, (index, name, values) => {
    if (!numericFlags[index]) return null;
    const plan = planNumeric(values, tuning);
    if (!plan) return null;
    const present = values.filter((value) => value !== null && String(value).trim() !== '').length;
    const parsed = plan.values.filter((value) => value !== null).length;
    if (present > 0) {
      parseRates.push({ column: name, parsed, total: present, rate: parsed / present });
    }
    for (const kind of plan.kinds) {
      const count = plan.values.filter((value) => value !== null).length;
      conversions.push({ column: name, kind, count });
    }
    if (plan.units?.length) {
      cleanNotes.push(`column "${name}": unit word(s) discovered from the data: ${plan.units.join(', ')} (T2)`);
    }
    if (plan.magnitudes?.length) {
      cleanNotes.push(`column "${name}": magnitude suffix(es) applied: ${plan.magnitudes.join(', ')} (T2)`);
    }
    if (plan.moved > 0) {
      cleanNotes.push(
        `column "${name}": ${plan.moved} non-numeric value(s) moved to ${name}_note; ${parsed} of ${present} parsed (${((parsed / Math.max(1, present)) * 100).toFixed(1)}%) (T1)`,
      );
      reviewItems.push({
        id: `parse_gap:${name}`,
        kind: 'parse_gap',
        column: name,
        rowIndex: null,
        original: plan.notes.find((value) => value !== null) as string | undefined ?? '',
        suggested: 'kept in the note column',
        confidence: 0.75,
        reason: `${parsed} of ${present} value(s) parsed as numbers; the rest keep their original text in ${name}_note`,
        applied: true,
      });
    }
    const result = convertNumeric(plan.values);
    if (plan.moved === 0 && result.converted === 0 && plan.converted === 0) return null;
    fired.add('R4');
    spelledNumbers += result.spelled + (plan.spelled ?? 0);
    if ((plan.spelled ?? 0) > 0) {
      fired.add('R13');
      cleanNotes.push(`column "${name}": ${plan.spelled} spelled-out number(s) converted to digits (R13)`);
    }
    const names = [name];
    const columnsOut: Cell[][] = [result.values];
    const forceOut = [force[index] ?? false];
    const convOut = [(conv[index] ?? 0) + result.converted + plan.converted];
    if (plan.moved > 0) {
      names.push(`${name}_note`);
      columnsOut.push(plan.notes);
      forceOut.push(false);
      convOut.push(0);
    }
    if (result.spelled > 0) {
      cleanNotes.push(`column "${name}": ${result.spelled} spelled-out number(s) converted to digits (R13)`);
    }
    return { names, force: forceOut, conv: convOut, columns: columnsOut };
  });
  if (spelledNumbers > 0) fired.add('R13');
  columns = numericRebuilt.columns;
  force = numericRebuilt.force;
  conv = numericRebuilt.conv;
  rows = numericRebuilt.rows;

  // ---- 13. R6: category clustering + reshaping ---------------------------
  const mappings: ValueMapping[] = [];
  types = columns.map((_name, index) => inferType(rows.map((row) => row[index])));
  columns.forEach((name, index) => {
    if (types[index] !== 'text') return;
    const result = normalizeCategories(name, rows.map((row) => row[index]), force[index] ?? false);
    result.values.forEach((value, rowIndex) => {
      rows[rowIndex][index] = value;
    });
    conv[index] += result.conversions;
    mappings.push(...result.mappings);
    // S1 – values that differ by a symbol are never merged; they are listed so
    // the human can decide whether they are one category or two.
    for (const group of result.similar) {
      fired.add('S1');
      mappings.push({
        column: name,
        from: 'review: similar values',
        to: group.values.join(' / '),
        count: group.count,
      });
      reviewItems.push({
        id: `similar_values:${name}:${group.values.join('|')}`,
        kind: 'similar_values',
        column: name,
        rowIndex: null,
        original: group.values.join(' / '),
        suggested: 'kept separate – a leading or trailing symbol is significant',
        confidence: 0.5,
        reason:
          'these values differ only by a symbol, so they were never merged; keep them apart unless you know they mean the same thing',
        applied: false,
      });
      cleanNotes.push(
        `column "${name}": ${group.values.join(' / ')} kept separate and listed as "review: similar values" (S1)`,
      );
    }
    if (result.conversions > 0) {
      fired.add('R6');
      cleanNotes.push(`column "${name}": ${result.conversions} value(s) clustered to a canonical category form (R6)`);
    }
  });

  // ---- 13a. N1/N2/N3: normalisations that need no guessing --------------
  for (let index = 0; index < columns.length; index += 1) {
    if (types[index] !== 'text') continue;
    const name = columns[index] as string;
    if (name.endsWith('_note')) continue;
    const values = rows.map((row) => row[index]);

    // N1 – one boolean vocabulary family across the column.
    const booleans = booleanFamily(values);
    if (booleans) {
      booleans.values.forEach((value, rowIndex) => {
        rows[rowIndex][index] = value;
      });
      types[index] = 'boolean';
      conversions.push({ column: name, kind: `boolean family ${booleans.family}`, count: values.length });
      cleanNotes.push(`column "${name}": values unified to booleans (${booleans.family} family) (N1)`);
      continue;
    }

    // N2 – email column: trim and lowercase.
    const emails = planEmails(values, tuning);
    if (emails && emails.converted > 0) {
      emails.values.forEach((value, rowIndex) => {
        rows[rowIndex][index] = value;
      });
      conversions.push({ column: name, kind: 'email (trim + lowercase)', count: emails.converted });
      cleanNotes.push(`column "${name}": ${emails.converted} email address(es) trimmed and lowercased (N2)`);
      continue;
    }

    // N3 – phone column: strip separators, 00 → +, one shared country code.
    const phones = planPhones(values, tuning);
    if (phones && phones.converted > 0) {
      phones.values.forEach((value, rowIndex) => {
        rows[rowIndex][index] = value;
      });
      const kind = phones.countryCode ? `phone (country code ${phones.countryCode} recorded)` : 'phone';
      conversions.push({ column: name, kind, count: phones.converted });
      cleanNotes.push(
        `column "${name}": ${phones.converted} phone number(s) normalised (N3)` +
          (phones.countryCode ? `; all share country code ${phones.countryCode}, recorded in the report` : '') +
          (phones.flagged > 0 ? `; ${phones.flagged} value(s) have no country code and were flagged` : ''),
      );
    }
  }

  // ---- 13b. R17: multi-item columns get <col>_item_count -----------------
  const itemPlans: { name: string; counts: Cell[] }[] = [];
  columns.forEach((name, index) => {
    if (types[index] !== 'text' || name.endsWith('_item_count')) return;
    const plan = planItems(rows.map((row) => row[index]));
    if (!plan.active) return;
    if (columns.includes(`${name}_item_count`)) return;
    itemPlans.push({ name: `${name}_item_count`, counts: plan.counts });
    cleanNotes.push(
      `column "${name}": ${plan.multiCells} cell(s) hold multiple items – ${name}_item_count added (R17, never exploded in place)`,
    );
  });
  if (itemPlans.length > 0) fired.add('R17');
  for (const plan of itemPlans) {
    columns.push(plan.name);
    force.push(false);
    conv.push(0);
    types.push('number');
    rows.forEach((row, index) => row.push(plan.counts[index] ?? null));
  }

  // ---- 14. drop empty columns -------------------------------------------
  const keep = columns.map((_name, index) => rows.some((row) => !isNullSentinel(row[index])));
  const emptyColumnsDropped = keep.filter((value) => !value).length;
  if (keep.some((value) => !value)) {
    cleanNotes.push(`${emptyColumnsDropped} empty column(s) removed`);
    columns = columns.filter((_name, index) => keep[index]);
    force = force.filter((_name, index) => keep[index]);
    conv = conv.filter((_name, index) => keep[index]);
    types = types.filter((_name, index) => keep[index]);
    rows = rows.map((row) => row.filter((_cell, index) => keep[index]));
  }

  // ---- 15. final type conversion ----------------------------------------
  types = [];
  for (let index = 0; index < columns.length; index += 1) {
    const values = rows.map((row) => row[index]);
    // The same content-only decision the earlier stages used: a boolean family
    // such as Y/N or T/F must not be re-read as text here.
    let type = columns[index]?.endsWith('_note') ? 'text' : decideType(values, tuning).type;
    // A "date" column must hold ISO values only; anything the file left
    // unproven (or unparseable) demotes the column to text instead of lying.
    if (type === 'date') {
      const allIso = values.every(
        (value) => value === null || value === undefined || typeof value !== 'string' || ISO_VALUE_RE.test(value),
      );
      if (!allIso) type = 'text';
    }
    types.push(type);
    const conversion = convertColumn(values, type);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      rows[rowIndex][index] = conversion.values[rowIndex];
    }
    for (const note of conversion.notes) cleanNotes.push(`column "${columns[index]}": ${note}`);
  }

  // ---- 16. R8: de-duplicate rows ----------------------------------------
  const seen = new Set<string>();
  const deduped: Cell[][] = [];
  let duplicatesRemoved = 0;
  for (const row of rows) {
    const key = row.map(cellKey).join('\u0001');
    if (seen.has(key)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  rows = deduped;
  if (duplicatesRemoved > 0) {
    fired.add('R8');
    cleanNotes.push(`${duplicatesRemoved} duplicate row(s) removed (R8)`);
  }

  // ---- 17. R9: logic flags ----------------------------------------------
  const state = { columns, force, conv, types, rows };
  const flagNames: string[] = [];
  const flagCounts: { name: string; count: number }[] = [];

  const countFlag = (name: string): number => {
    const index = state.columns.indexOf(name);
    if (index < 0) return 0;
    return state.rows.reduce<number>((total, row) => (row[index] === true ? total + 1 : total), 0);
  };
  const registerFlag = (name: string, count: number): void => {
    if (flagCounts.some((entry) => entry.name === name)) return;
    flagCounts.push({ name, count });
    if (count > 0 && !flagNames.includes(name)) flagNames.push(name);
  };

  for (const flag of buildLogicFlags(state.columns, state.rows, state.types, exportDate)) {
    const exists = state.columns.includes(flag.name);
    const count = exists ? countFlag(flag.name) : flag.count;
    if (!exists && flag.count > 0) {
      appendFlag(state, flag.name, flag.values);
      fired.add('R9');
      cleanNotes.push(`column "${flag.name}": ${flag.count} row(s) flagged (R9 – flag only, never removed)`);
    }
    registerFlag(flag.name, count);
  }

  for (const name of ['date_ambiguous', 'date_future']) {
    registerFlag(name, countFlag(name));
  }

  // R8 – same id, different content → keep both rows, flag the conflict.
  const conflicts = idConflictFlags(state.columns, state.rows, idColumns);
  const conflictCount = conflicts ? conflicts.filter(Boolean).length : 0;
  if (conflicts && conflictCount > 0 && !state.columns.includes('duplicate_id_conflict')) {
    appendFlag(state, 'duplicate_id_conflict', conflicts);
    fired.add('R8');
    cleanNotes.push(`column "duplicate_id_conflict": ${conflictCount} row(s) share an id but differ (R8)`);
  }
  registerFlag('duplicate_id_conflict', countFlag('duplicate_id_conflict'));

  if (state.columns.includes('system_flag')) {
    registerFlag('system_flag', countFlag('system_flag'));
    if (hasSystem) fired.add('R7');
  }
  if (state.columns.includes('missing_id')) {
    registerFlag('missing_id', countFlag('missing_id'));
  }

  columns = state.columns;
  force = state.force;
  conv = state.conv;
  types = state.types;
  rows = state.rows;

  // ---- 18. missing values + outliers ------------------------------------
  const columnMeta: ColumnMeta[] = [];
  let valuesFilled = 0;
  let outliersFlagged = 0;
  let flaggedNulls = 0;
  const fillsByColumn = new Array<number>(columns.length).fill(0);

  for (let index = 0; index < columns.length; index += 1) {
    const values = rows.map((row) => row[index]);
    const nulls = values.filter((value) => value === null).length;

    if (nulls > 0 && types[index] === 'text' && rows.length >= 5 && nulls <= rows.length * 0.1) {
      const present = values.filter((value) => value !== null);
      const mode = modeOf(values);
      const modeCount = present.filter((value) => cellKey(value) === cellKey(mode as Cell)).length;
      if (mode !== null && present.length > 0 && modeCount / present.length >= 0.5) {
        // Low confidence (principle 2): filling gaps with the mode invents
        // data, so the original nulls stay and the fill is offered for review.
        const fillId = `value_fill:${columns[index]}`;
        const fillIt = accepted.has(fillId);
        if (fillIt) {
          for (const row of rows) {
            if (row[index] === null) {
              row[index] = mode;
              valuesFilled += 1;
              fillsByColumn[index] += 1;
            }
          }
          cleanNotes.push(`column "${columns[index]}": ${nulls} gap(s) filled with the column mode (accepted)`);
        } else {
          flaggedNulls += nulls;
        }
        reviewItems.push({
          id: fillId,
          kind: 'value_fill',
          column: columns[index],
          rowIndex: null,
          original: '',
          suggested: displayCell(mode),
          confidence: 0.4,
          reason: `${nulls} gap(s); the column value "${displayCell(mode)}" fills ${(modeCount / present.length * 100).toFixed(0)}% of the filled cells`,
          applied: fillIt,
        });
      } else {
        flaggedNulls += nulls;
      }
    } else if (nulls > 0) {
      flaggedNulls += nulls;
      if (types[index] !== 'text') {
        cleanNotes.push(
          `column "${columns[index]}": ${nulls} missing value(s) left as null (${types[index]} column)`,
        );
      }
    }

    const present = values.filter((value) => value !== null);
    const unique = new Set(present.map(cellKey)).size;

    let outliers = 0;
    if (types[index] === 'number' && present.length >= 8) {
      const numbers = (present.filter((value) => typeof value === 'number') as number[]).sort((a, b) => a - b);
      if (numbers.length >= 8) {
        const q1 = quantile(numbers, 0.25);
        const q3 = quantile(numbers, 0.75);
        const iqr = q3 - q1;
        if (iqr > 0) {
          const low = q1 - 1.5 * iqr;
          const high = q3 + 1.5 * iqr;
          outliers = numbers.filter((value) => value < low || value > high).length;
          if (outliers > 0) {
            cleanNotes.push(`column "${columns[index]}": ${outliers} outlier(s) flagged by IQR – left untouched`);
          }
        }
      }
    }
    outliersFlagged += outliers;

    const examples: Cell[] = [];
    for (const value of present) {
      if (examples.length >= 3) break;
      examples.push(value);
    }

    columnMeta.push({
      name: columns[index],
      type: types[index],
      nulls: values.length - present.length,
      filled: fillsByColumn[index] ?? 0,
      unique,
      outliers,
      conversions: conv[index] ?? 0,
      examples,
    });
  }

  if (flaggedNulls > 0) cleanNotes.push(`${flaggedNulls} missing value(s) flagged across all columns`);

  // ---- 19. R10 / R15 / R18: controls, overlaps --------------------------
  const reported = findReportedTotal(rejected);
  const reconciliation = reconcile(columns, rows, types, reported);
  if (reconciliation) {
    if (reconciliation.reported !== null) fired.add('R10');
    cleanNotes.push(
      reconciliation.reported === null
        ? `reconciliation: sum of ${reconciliation.column} = ${reconciliation.parsed} (file declares no total)`
        : `reconciliation (R10): ${reconciliation.column} parsed ${reconciliation.parsed} vs reported ${reconciliation.reported} → difference ${reconciliation.difference}`,
    );
  }

  const rowControlRaw = findRowControl(rejected);
  const rowControl = rowControlRaw
    ? {
        reported: rowControlRaw.reported,
        actual: rows.length,
        matches: rowControlRaw.reported === rows.length,
        source: rowControlRaw.source,
      }
    : null;
  if (rowControl) {
    fired.add('R15');
    cleanNotes.push(
      `row control (R15): the file declares ${rowControl.reported} row(s), the clean table has ${rowControl.actual} → ${rowControl.matches ? 'matches' : 'does not match'}`,
    );
  }

  const overlapping: OverlapEntry[] = [];
  types.forEach((type, index) => {
    if (type !== 'text') return;
    const values = rows.map((row) => row[index]);
    if (!isCategoryColumn(values)) return;
    for (const entry of findOverlaps(columns[index], values)) {
      overlapping.push(entry);
      fired.add('R18');
      const count = values.filter(
        (value) => typeof value === 'string' && categoryKey(value) === categoryKey(entry.value),
      ).length;
      mappings.push({
        column: entry.column,
        from: 'review: overlapping',
        to: `${entry.value} = ${entry.parts.join(' + ')}`,
        count,
      });
      reviewItems.push({
        id: `overlap:${entry.column}:${categoryKey(entry.value)}`,
        kind: 'overlap',
        column: entry.column,
        rowIndex: null,
        original: entry.value,
        suggested: 'keep as one value – the parts are also values of this column',
        confidence: 0.5,
        reason: `this value combines ${entry.parts.join(', ')}, which each exist on their own – listed under "review: overlapping", never auto-merged (R18)`,
        applied: false,
      });
    }
  });
  if (overlapping.length > 0) {
    cleanNotes.push(`R18: ${overlapping.length} overlapping value(s) listed in Value mappings – never auto-merged`);
  }

  const fileReport: FileReport = {
    fileName,
    sourceType,
    strategy: raw.strategy,
    rowsIn,
    rowsOut: rows.length,
    columnsIn: columns.length,
    columnsOut: columns.length,
    duplicatesRemoved,
    emptyRowsDropped,
    emptyColumnsDropped,
    nullsFixed,
    valuesFilled,
    outliersFlagged,
    headerDetected,
    generatedHeaders: generated,
    rejectedCount: rejected.length,
    rejectedReasons: rejectReasons(rejected),
    ambiguousDates,
    // Counted here so the Quality Report can state it without the UI having to
    // re-scan the table, and so the number does not depend on the toggle.
    spreadsheetSafeCells: countFormulaLike(rows, types),
    flagCounts,
    mappings,
    reconciliation,
    rowControl,
    exportDate,
    rulesFired: [...fired],
    reviewItems,
    spelledNumbers,
    overlapping,
    parseRates,
    conversions,
    notes: [...notes, ...cleanNotes],
  };

  const report: QualityReport = { ...fileReport, files: [fileReport], columns: columnMeta };

  return { columns, types, rows, rejected, flagColumns: flagNames, review: reviewItems, report };
}

// ---- R8: same id, different content -------------------------------------

/** Rows that share an id but not their content (null when there are no ids). */
function idConflictFlags(columns: string[], rows: Cell[][], idColumns: string[]): boolean[] | null {
  if (idColumns.length === 0) return null;
  const flags = new Array<boolean>(rows.length).fill(false);
  let any = false;

  for (const name of idColumns) {
    const index = columns.indexOf(name);
    if (index < 0) continue;
    const groups = new Map<string, number[]>();
    rows.forEach((row, rowIndex) => {
      const value = row[index];
      if (value === null || value === undefined) return;
      const key = String(value);
      const bucket = groups.get(key);
      if (bucket) bucket.push(rowIndex);
      else groups.set(key, [rowIndex]);
    });
    for (const bucket of groups.values()) {
      if (bucket.length < 2) continue;
      const signatures = new Set(bucket.map((rowIndex) => rows[rowIndex].map(cellKey).join('\u0001')));
      if (signatures.size < 2) continue;
      bucket.forEach((rowIndex) => {
        flags[rowIndex] = true;
      });
      any = true;
    }
  }

  return any ? flags : null;
}