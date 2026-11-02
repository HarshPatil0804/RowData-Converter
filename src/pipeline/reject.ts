import type { Cell, RejectedRow } from '../types';
import { looksLikeHeaderRow } from '../lib/table';
import { isNullSentinel } from '../lib/strings';

/**
 * R1 – junk row detection, run before anything else touches the data.
 *
 * Title lines, export-date lines, blank rows, error rows (ERR_*, SYSTEM
 * ALERT) and summary/total lines are moved to a "Rejected rows" table with a
 * reason instead of being deleted. The rules are structural (how many cells
 * are filled) plus a text pattern on the first cell, so they work for any
 * file – nothing here knows about a particular dataset.
 */

/** Empty means "no content": null, undefined, blank text or a null sentinel
 * ("N/A", "-", "none"…). Sentinels count as empty *before* cleaning so a row
 * of nothing but placeholders is rejected as blank instead of surviving into
 * the clean table (invariant 1 and 5 depend on this). */
export function isEmptyCell(cell: Cell): boolean {
  if (cell === null || cell === undefined) return true;
  if (typeof cell === 'boolean') return false;
  if (typeof cell === 'number') return false;
  return isNullSentinel(cell);
}

function firstText(row: Cell[]): string {
  for (const cell of row) {
    if (isEmptyCell(cell)) continue;
    return String(cell).trim();
  }
  return '';
}

/** ERR_…, ERROR …, "SYSTEM ALERT: …", anything ending in _FAILED / _ERROR. */
export const ERROR_RE =
  /^(?:err(?:or)?[_\s:.-]|system\s+(?:alert|error|log|failure|message)\b|[\w.-]*(?:_failed|_error)\b)/i;
/** Control totals: "TOTAL …", "SUBTOTAL …", "GRAND TOTAL …", "SUMMARY …". */
export const TOTAL_RE = /^(?:grand\s+total|sub\s*total|totals?\b|summary\b|overall\b|aggregate\b)/i;
/** Exporter metadata: "Export Date:", "Export generated:", "Created at". */
export const META_RE =
  /^(?:export\b|generated\b|report\s+(?:date|generated|created)\b|created\s+(?:at|on)\b|last\s+(?:updated|modified)\b|timestamp\b)/i;
/**
 * R11 – footer/marker lines. A lone cell in a dense table, a closing marker
 * ("END", "--- END ---", "# EOF #"), or a sign-off line ("Prepared by:",
 * "Notice:", "Generated on") is never data.
 */
export const FOOTER_RE =
  /^(?:#+\s*)?(?:prepared\s+by|notice\b|generated\s+on\b|disclaimer\b|signed\s+by\b|signature\b|end\s+of\s+file|eof\b)(?:\s*[:.\-|.#]*)/i;
/** A pure end-of-data marker cell: "END", "# END #", "end of records". */
export const END_RE =
  /^(?:#+\s*)?end(?:\s*(?:of\s+)?(?:file|data|record(?:s)?|report|document|table|input))?(?:\s*[-:.|#]*\s*)$/i;

/** Most common row width – robust against one stray long/short line. */
export function modalWidth(rows: Cell[][]): number {
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  let best = 1;
  let bestCount = -1;
  for (const [width, times] of counts) {
    if (times > bestCount || (times === bestCount && width > best)) {
      best = width;
      bestCount = times;
    }
  }
  return best;
}

function padTo(row: Cell[], width: number): Cell[] {
  const out = row.slice(0, width);
  while (out.length < width) out.push(null);
  return out;
}

function filledCount(row: Cell[]): number {
  let filled = 0;
  for (const cell of row) if (!isEmptyCell(cell)) filled += 1;
  return filled;
}

export type HeaderMode = 'auto' | 'yes' | 'no';

export interface RejectResult {
  /** Rows that survived R1, padded to the modal width. */
  kept: Cell[][];
  rejected: RejectedRow[];
  /** Index of the header row inside `kept`, or -1 when there is none. */
  headerIndex: number;
}

/**
 * R11 – is this row a footer/marker fragment rather than data?
 *
 * The "one lone cell" rule only fires in a file that is otherwise dense
 * (`modalFilled >= 2`): a genuinely sparse file (a contact card, a key/value
 * list) is data, not footers.
 */
function isFooterRow(padded: Cell[], width: number, filled: number, modalFilled: number): boolean {
  if (width < 2) return false; // single-column tables are prose, not rows
  const head = firstText(padded);
  if (head === '') return false;
  if (END_RE.test(head)) return true;
  if (FOOTER_RE.test(head)) return true;
  // "only the first cell is filled" – one lone cell in a multi-column table.
  return filled === 1 && modalFilled >= 2;
}

/** Most common number of filled cells per row (density of the file). */
function modalFilledCount(rows: Cell[][], width: number): number {
  const counts = new Map<number, number>();
  for (const row of rows) {
    const filled = filledCount(padTo(row, width));
    counts.set(filled, (counts.get(filled) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [filled, times] of counts) {
    if (times > bestCount || (times === bestCount && filled > best)) {
      best = filled;
      bestCount = times;
    }
  }
  return best;
}

/**
 * Classify every row and locate the header.
 *
 * In `auto` mode the file's leading banners are consumed first: a sparse row
 * is a banner when a dense, header-shaped row follows it. That is what lets
 * the real header ("Visit_ID | Patient_Details | …") be found underneath a
 * title and an export-date line instead of the title being mistaken for it.
 *
 * R11 – everything after an END marker is footer and is rejected before any
 * other rule sees it.
 */
export function rejectRows(raw: Cell[][], mode: HeaderMode, columnsKnown: boolean): RejectResult {
  const width = modalWidth(raw);
  // A row is "sparse" when almost none of its fields carry content. Data rows
  // fill most cells even when a couple of values are missing; banners fill one
  // or two. Requiring sparseness keeps every text rule off real data rows.
  const sparseAt = Math.max(1, Math.floor(width / 3));
  const modalFilled = modalFilledCount(raw, width);

  // R11 pre-scan: locate the first END marker; everything after it is footer.
  let endIndex = -1;
  if (width >= 2) {
    for (let index = 0; index < raw.length; index += 1) {
      if (END_RE.test(firstText(padTo(raw[index], width)))) {
        endIndex = index;
        break;
      }
    }
  }

  const kept: Cell[][] = [];
  const rejected: RejectedRow[] = [];
  let headerIndex = -1;

  const classify = (index: number): 'rejected' | 'kept' => {
    const padded = padTo(raw[index], width);
    if (endIndex >= 0 && index > endIndex) {
      rejected.push({ reason: 'footer line (after END marker)', values: padded });
      return 'rejected';
    }
    if (endIndex === index) {
      rejected.push({ reason: 'footer/marker line', values: padded });
      return 'rejected';
    }
    const filled = filledCount(padded);
    if (filled === 0) {
      rejected.push({ reason: 'blank row', values: padded });
      return 'rejected';
    }
    if (filled <= sparseAt) {
      const head = firstText(padded);
      if (ERROR_RE.test(head)) {
        rejected.push({ reason: 'error row', values: padded });
        return 'rejected';
      }
      if (TOTAL_RE.test(head)) {
        rejected.push({ reason: 'summary/total line', values: padded });
        return 'rejected';
      }
      if (META_RE.test(head)) {
        rejected.push({ reason: 'export metadata line', values: padded });
        return 'rejected';
      }
      if (isFooterRow(padded, width, filled, modalFilled)) {
        rejected.push({ reason: 'footer/marker line', values: padded });
        return 'rejected';
      }
    } else if (isFooterRow(padded, width, filled, modalFilled)) {
      // dense row whose first cell is a pure marker (END / EOF)
      rejected.push({ reason: 'footer/marker line', values: padded });
      return 'rejected';
    }
    kept.push(padded);
    return 'kept';
  };

  // Nothing to locate: the extractor already resolved the columns.
  if (columnsKnown || mode === 'no') {
    if (mode === 'yes' && raw.length > 0) {
      kept.push(padTo(raw[0], width));
      headerIndex = 0;
      for (let index = 1; index < raw.length; index += 1) classify(index);
      return { kept, rejected, headerIndex };
    }
    for (let index = 0; index < raw.length; index += 1) classify(index);
    return { kept, rejected, headerIndex };
  }

  if (mode === 'yes' && raw.length > 0) {
    kept.push(padTo(raw[0], width));
    headerIndex = 0;
    for (let index = 1; index < raw.length; index += 1) classify(index);
    return { kept, rejected, headerIndex };
  }

  // ---- auto: consume the banner block, then find the header --------------
  const hasHeaderAfter = (from: number): boolean => {
    const limit = Math.min(raw.length, from + 11);
    for (let index = from + 1; index < limit; index += 1) {
      const candidate = padTo(raw[index], width);
      if (filledCount(candidate) <= sparseAt) continue;
      if (looksLikeHeaderRow(candidate, raw.slice(index + 1))) return true;
    }
    return false;
  };

  let index = 0;
  while (index < raw.length) {
    const padded = padTo(raw[index], width);
    const filled = filledCount(padded);
    if (filled === 0) {
      rejected.push({ reason: 'blank row', values: padded });
      index += 1;
      continue;
    }
    if (filled > sparseAt) break;

    const head = firstText(padded);
    if (ERROR_RE.test(head)) rejected.push({ reason: 'error row', values: padded });
    else if (TOTAL_RE.test(head)) rejected.push({ reason: 'summary/total line', values: padded });
    else if (META_RE.test(head)) rejected.push({ reason: 'export metadata line', values: padded });
    else if (hasHeaderAfter(index)) rejected.push({ reason: 'title line', values: padded });
    else if (isFooterRow(padded, width, filled, modalFilled)) rejected.push({ reason: 'footer/marker line', values: padded });
    else break;
    index += 1;
  }

  if (index < raw.length) {
    const candidate = padTo(raw[index], width);
    if (looksLikeHeaderRow(candidate, raw.slice(index + 1))) {
      headerIndex = kept.length;
    }
    kept.push(candidate);
    index += 1;
  }
  for (; index < raw.length; index += 1) classify(index);

  return { kept, rejected, headerIndex };
}

/** Count rejected rows per reason, in first-seen order. */
export function rejectReasons(rejected: RejectedRow[]): { reason: string; count: number }[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const row of rejected) {
    const seen = counts.get(row.reason);
    if (seen === undefined) {
      order.push(row.reason);
      counts.set(row.reason, 1);
    } else {
      counts.set(row.reason, seen + 1);
    }
  }
  return order.map((reason) => ({ reason, count: counts.get(reason) ?? 0 }));
}

/**
 * R15 – row-count control line: "Total rows: 999", "50 records", "120
 * entries counted". Found among the rejected junk lines and compared with the
 * number of clean rows by the report.
 */
export function findRowControl(rejected: RejectedRow[]): { reported: number; source: string } | null {
  const COUNT_AFTER = /\b(?:rows?|records?|entries|lines?|items?)\b\s*(?:count(?:ed)?|total)?\s*[:=]\s*([\d,]+)/i;
  const COUNT_BEFORE = /\b([\d,]+)\s*(?:rows?|records?|entries|lines?|items?)\b/i;
  for (const row of rejected) {
    if (row.reason === 'blank row' || row.reason === 'error row') continue;
    const text = row.values
      .filter((cell) => cell !== null && cell !== undefined)
      .map((cell) => String(cell))
      .join(' ');
    const match = COUNT_AFTER.exec(text) ?? COUNT_BEFORE.exec(text);
    if (!match) continue;
    const reported = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(reported)) continue;
    return { reported, source: text.trim() };
  }
  return null;
}

/**
 * R10 helper – find the file's export/generated date so date_future and
 * scheduled_in_past have a reference point. Returns null when the file does
 * not declare one, in which case those flags are simply not raised.
 */
export function findExportDate(rejected: RejectedRow[]): string | null {
  for (const row of rejected) {
    const head = row.values.find((cell) => !isEmptyCell(cell));
    if (head === undefined) continue;
    if (!META_RE.test(String(head).trim())) continue;
    for (const cell of row.values) {
      if (isEmptyCell(cell)) continue;
      const match = /(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})/.exec(String(cell).trim());
      if (!match) continue;
      const iso = toIsoDate(match[1]);
      if (iso) return iso;
    }
  }
  return null;
}

function toIsoDate(value: string): string | null {
  const parts = value.split(/[-/]/).map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const [a, b, c] = parts as [number, number, number];
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (a > 31) return `${a}-${pad(b)}-${pad(c)}`;
  if (c > 31) return `${c}-${pad(b)}-${pad(a)}`;
  return null;
}