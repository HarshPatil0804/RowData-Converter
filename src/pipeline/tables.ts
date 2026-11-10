/**
 * S2 – two tables in one file.
 *
 * A delimited export is not always one table. A section marker ("Shipments")
 * can sit between two blocks, and a second block can start with its own header
 * row whose labels do not match the first table's. Appending those rows under
 * the first header is silent wrong data, so the rows are split into separate
 * tables before anything is cleaned:
 *
 *   - a lone short text cell followed by a header-like row is a section marker;
 *   - a header-like row after data is a new header when the column shapes flip
 *     under it — the row itself carries no numbers or dates, while the rows
 *     below it do in the same places.
 *
 * Both tests are content-only (no column names, no file names, no values from
 * a fixture). When the evidence is weak nothing is split, and the caller leaves
 * the rows where they are: a wrong split is worse than no split.
 */
import type { Cell, RawTable } from '../types';
import { cleanText } from '../lib/strings';
import { parseNumberValue } from '../lib/numbers';
import { looksLikeDate } from '../lib/dates';

type Shape = 'number' | 'date' | 'text' | 'empty';

function shapeOf(cell: Cell): Shape {
  if (cell === null || cell === undefined) return 'empty';
  if (typeof cell === 'number') return Number.isFinite(cell) ? 'number' : 'empty';
  if (typeof cell === 'boolean') return 'text';
  const text = cleanText(cell).trim();
  if (text === '') return 'empty';
  if (!text.startsWith('+') && parseNumberValue(text) !== null) return 'number';
  if (looksLikeDate(text)) return 'date';
  return 'text';
}

function labelKey(cell: Cell): string {
  return cleanText(cell === null || cell === undefined ? '' : String(cell)).trim().toLowerCase().replace(/\s+/g, ' ');
}

function filled(row: Cell[]): Cell[] {
  return row.filter((cell) => cell !== null && cell !== undefined && String(cell).trim() !== '');
}

/** A label cell: short, no sentence punctuation, not a number or a date. */
function looksLabel(cell: Cell): boolean {
  if (shapeOf(cell) !== 'text') return false;
  const text = cleanText(String(cell)).trim();
  return text.length > 0 && text.length <= 40 && text.split(/\s+/).length <= 5 && !/[.;:]$/.test(text);
}

function allDistinct(row: Cell[]): boolean {
  const keys = filled(row).map(labelKey);
  return new Set(keys).size === keys.length;
}

/** Could this row be a header for a table of this width? */
export function looksLikeHeaderCandidate(row: Cell[], width: number): boolean {
  const cells = filled(row);
  if (cells.length < 2 || cells.length < Math.min(width, 2)) return false;
  if (!cells.every(looksLabel)) return false;
  return allDistinct(row);
}

/**
 * The rows below this one behave like data for the header it offers: the cells
 * that are labels here are numbers or dates for most of the rows below.
 */
function shapeFlipsUnder(row: Cell[], below: Cell[][]): boolean {
  if (below.length === 0) return false;
  const labelColumns: number[] = [];
  row.forEach((cell, index) => {
    if (looksLabel(cell)) labelColumns.push(index);
  });
  if (labelColumns.length < 2) return false;
  // The candidate row must not itself carry numbers or dates: a real data row
  // does, and that is what distinguishes it from a header.
  if (row.some((cell) => {
    const shape = shapeOf(cell);
    return shape === 'number' || shape === 'date';
  })) {
    return false;
  }
  let flipped = 0;
  for (const column of labelColumns) {
    const values = below.map((line) => shapeOf(line[column] ?? null)).filter((shape) => shape !== 'empty');
    if (values.length === 0) continue;
    const typed = values.filter((shape) => shape === 'number' || shape === 'date').length;
    if (typed / values.length >= 0.7) flipped += 1;
  }
  // Two columns of the new header must behave like data underneath it (a date
  // and a number, typically). Scaling the requirement with the file width made
  // it impossible to satisfy in a wide table.
  return flipped >= 2;
}

export interface SplitTable {
  table: RawTable;
  /** 1-based position of the block in the file. */
  index: number;
  /** Row range in the original table (1-based, header included). */
  firstRow: number;
  lastRow: number;
  /** Section marker or repeated-header text that started this block, if any. */
  marker?: string;
}

/**
 * Split a raw table at section markers and at header-like rows whose column
 * shapes flip underneath them. Always returns at least one table.
 */
export function splitTables(raw: RawTable): SplitTable[] {
  // A one-column block (a contact card, a key: value list) is not a set of
  // tables: there is no column shape to flip.
  const denseRows = raw.rows.filter((row) => filled(row).length >= 2).length;
  if (raw.rows.length < 2 || denseRows < Math.max(2, Math.floor(raw.rows.length * 0.5))) {
    return [{ table: raw, index: 1, firstRow: 1, lastRow: raw.rows.length + 1 }];
  }

  interface Block {
    columns?: string[];
    rows: Cell[][];
    marker?: string;
    start: number;
  }

  // The reader usually hands over rows without committing to a header; the
  // first row is used here for detection only, and only when it looks like a
  // header. When nothing splits, the table is returned untouched so the normal
  // header logic keeps deciding.
  let columns = raw.columns.map((name) => String(name));
  let bodyStart = 0;
  if (columns.length < 2) {
    const first = raw.rows[0] ?? [];
    if (!looksLikeHeaderCandidate(first, first.length) || filled(first).length < 2) {
      return [{ table: raw, index: 1, firstRow: 1, lastRow: raw.rows.length + 1 }];
    }
    columns = first.map((cell) => String(cell ?? ''));
    bodyStart = 1;
  }

  const headerKeys = columns.map(labelKey);
  const blocks: Block[] = [{ rows: [], start: bodyStart + 1 }];
  let pendingMarker: string | undefined;

  const isRepeatedHeader = (row: Cell[]): boolean =>
    row.length === headerKeys.length &&
    row.every((cell, index) => labelKey(cell) === headerKeys[index]);

  const body = raw.rows.slice(bodyStart);
  for (let index = 0; index < body.length; index += 1) {
    const row = body[index] as Cell[];
    const current = blocks[blocks.length - 1] as Block;
    const below = body.slice(index + 1, index + 6);
    const cells = filled(row);

    // Page-break repeat of the same header: S3 rejects it, do not split.
    if (isRepeatedHeader(row)) {
      current.rows.push(row);
      continue;
    }

    // Section marker: one lone label, followed by a header-like row.
    const next = body[index + 1];
    if (cells.length === 1 && looksLabel(cells[0] as Cell) && next && looksLikeHeaderCandidate(next, columns.length)) {
      // Close the current block if it already has data, and open a new one whose
      // header is the row after the marker.
      if (current.rows.some((line) => filled(line).length > 0)) {
        blocks.push({ rows: [], marker: cleanText(String(cells[0])).trim(), start: bodyStart + index + 3 });
        const opened = blocks[blocks.length - 1] as Block;
        opened.columns = (next as Cell[]).map((cell) => String(cell ?? ''));
        index += 1;
        continue;
      }
      pendingMarker = cleanText(String(cells[0])).trim();
      continue;
    }

    // A second header after data, proven by the shape flip underneath it.
    const hasData = current.rows.some((line) => filled(line).length > 0);
    if (hasData && looksLikeHeaderCandidate(row, columns.length) && shapeFlipsUnder(row, below)) {
      blocks.push({
        columns: row.map((cell) => String(cell ?? '')),
        rows: [],
        marker: pendingMarker,
        start: bodyStart + index + 3,
      });
      pendingMarker = undefined;
      continue;
    }

    current.rows.push(row);
  }

  const kept = blocks.filter((block) => block.rows.some((line) => filled(line).length > 0));
  if (kept.length <= 1) return [{ table: raw, index: 1, firstRow: 1, lastRow: raw.rows.length + 1 }];

  return kept.map((block, position) => {
    const blockColumns = block.columns ?? columns;
    const notes = [...raw.notes];
    if (block.marker) notes.push(`table ${position + 1} starts at section marker "${block.marker}"`);
    notes.push(
      `S2: rows ${block.start}–${block.start + block.rows.length - 1} form table ${position + 1} of ${kept.length} in this file`,
    );
    return {
      index: position + 1,
      firstRow: block.start - 1,
      lastRow: block.start + block.rows.length - 2,
      marker: block.marker,
      table: {
        columns: blockColumns,
        rows: block.rows,
        hasHeader: true,
        strategy: `${raw.strategy} · table ${position + 1} of ${kept.length}`,
        notes,
      },
    };
  });
}
