import type { Cell, RejectedRow } from '../../types';
import { END_RE, ERROR_RE, FOOTER_RE, META_RE, TOTAL_RE } from '../reject';
import { logicalLines, normaliseText, splitCells } from './split';

/**
 * S4 – choose the table structure from CONTENT, never from the file extension.
 *
 * A real export is rarely made only of rows. It opens with a banner and an
 * export date, pads those lines with the delimiter it was told to use, and ends
 * with an error line and a control total. The old reader counted every one of
 * those padding delimiters, so a six-row pipe table inside a comma-padded file
 * looked like a comma table with four columns.
 *
 * The rule here is the one the data deserves:
 *
 *   1. classify lines that are not table lines (blank, delimiter-only padding,
 *      error / metadata / summary / footer lines);
 *   2. for every candidate delimiter, look only at lines that carry it at least
 *      twice, and find the modal field count;
 *   3. pick the (delimiter, field count) with the most consistent lines,
 *      breaking ties by more columns;
 *   4. lines that do not fit that structure are rejected with a reason – they
 *      are never table rows;
 *   5. nothing found → no table: the caller falls back to plain text.
 *
 * Because padding lines are classified before the vote, `,,,` can never vote
 * for the comma.
 */

/** Candidate delimiters, in the order used to break an exact tie. */
export const DELIMITERS = [',', ';', '\t', '|'] as const;

/** A structure needs this many agreeing lines before it is believed. */
const MIN_ROWS = 3;
/** Share of the delimiter's own lines that must agree on the field count. */
const MATCH_RATIO = 0.8;

export interface SniffedTable {
  delimiter: string;
  /** Modal field count of the lines that agree. */
  fields: number;
  /** Agreeing lines, in file order (header included; R1 finds it). */
  rows: Cell[][];
  /** Every other line, with the reason it is not a table row. */
  rejected: RejectedRow[];
  notes: string[];
  /** Agreeing lines / lines that carried this delimiter at least twice. */
  consistency: number;
}

interface LineInfo {
  text: string;
  /** Reason the line cannot be a table row, or null when it might be one. */
  junk: string | null;
}

/** Lines whose only content is delimiters or whitespace carry no data. */
function isPaddingOnly(trimmed: string): boolean {
  return trimmed.replace(/[,;|\t]/g, '').trim() === '';
}

/**
 * Text-pattern junk, applied only to sparse lines: a data row that happens to
 * start with the word "Summary" still fills several cells and is left alone.
 */
function junkReasonFor(trimmed: string): string | null {
  if (isPaddingOnly(trimmed)) return 'blank row';
  const counts = DELIMITERS.map((delimiter) => cellsOf(trimmed, delimiter).filter((cell) => cell !== '').length);
  if (Math.max(...counts) > 1) return null;

  const head = cellsOf(trimmed, ',')[0]?.trim() || trimmed;
  if (ERROR_RE.test(head)) return 'error row';
  if (TOTAL_RE.test(head)) return 'summary/total line';
  if (META_RE.test(head)) return 'export metadata line';
  if (FOOTER_RE.test(head) || END_RE.test(head)) return 'footer/marker line';
  return null;
}

/**
 * Cells of one line. Some exporters quote the WHOLE record instead of the
 * fields ("a | b | c") – a single quoted cell – so a line that produced exactly
 * one quoted cell is re-split without its wrapping quotes. A normal CSV whose
 * cells are quoted (`"a,b",c`) never reduces to one cell and is untouched.
 */
function cellsOf(line: string, delimiter: string): string[] {
  const cells = splitCells(line, delimiter);
  if (cells.length !== 1) return cells;
  const text = line.trim();
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) {
    return splitCells(text.slice(1, -1), delimiter);
  }
  return cells;
}

function classify(lines: string[]): LineInfo[] {
  return lines.map((text) => {
    const trimmed = text.trim();
    if (trimmed === '') return { text, junk: 'blank row' };
    return { text, junk: junkReasonFor(trimmed) };
  });
}

/** Most frequent field count; ties go to the wider row. */
function modalCount(counts: number[]): number {
  const frequency = new Map<number, number>();
  for (const count of counts) frequency.set(count, (frequency.get(count) ?? 0) + 1);
  let modal = 0;
  let best = 0;
  for (const [count, times] of frequency) {
    if (times > best || (times === best && count > modal)) {
      modal = count;
      best = times;
    }
  }
  return modal;
}

/**
 * Markdown tables and key:value files already have owners in the text ladder.
 * They are recognised here only so the delimiter vote cannot steal them: a
 * Markdown row `| a | b |` is a four-field pipe record to a splitter.
 */
function ownedByTextShape(lines: string[]): boolean {
  const nonBlank = lines.map((line) => line.trim()).filter((line) => line !== '');
  if (nonBlank.length < MIN_ROWS) return true;

  const markdownRows = nonBlank.filter((line) => /^\|.*\|$/.test(line)).length;
  // A `|---|:--:|` rule row unambiguously marks a Markdown table; the text
  // ladder owns it from there, whatever prose surrounds the table.
  const markdownRule = nonBlank.some((line) => /^\|[\s:|-]+\|$/.test(line) && line.includes('-'));
  if (markdownRule && markdownRows >= MIN_ROWS) return true;

  const keyValue = nonBlank.filter((line) => /^[A-Za-z][A-Za-z0-9_. -]{0,40}\s*[:=]\s*\S/.test(line)).length;
  if (keyValue / nonBlank.length >= 0.8) return true;

  return false;
}

/**
 * The widest record any candidate delimiter would produce. Used as a resource
 * limit even when the file has too few lines to be recognised as a table (a
 * two-line "CSV" with 5,000 commas is still 5,001 columns of work).
 */
export function widestRecord(text: string): number {
  let widest = 1;
  for (const line of logicalLines(normaliseText(text))) {
    if (line.trim() === '') continue;
    for (const delimiter of DELIMITERS) {
      const cells = cellsOf(line, delimiter).length;
      if (cells > widest) widest = cells;
    }
  }
  return widest;
}

/**
 * Sniff a table out of arbitrary text. Returns null when no delimiter produces
 * a consistent structure, which is the caller's signal to use plain text.
 */
export function sniffTable(text: string): SniffedTable | null {
  const lines = logicalLines(normaliseText(text));
  if (lines.length < MIN_ROWS) return null;
  if (ownedByTextShape(lines)) return null;

  const infos = classify(lines);

  type Vote = { delimiter: string; fields: number; matched: number; candidates: number };
  // The first line that carries content: the header in a table, the first
  // record in a headerless one. A real table separates it too.
  const firstContent = infos.find((info) => !info.junk) ?? null;

  const vote = (minOccurrences: number): Vote | null => {
    let winner: Vote | null = null;
    for (const delimiter of DELIMITERS) {
      // A single-occurrence structure is only believed when the first content
      // line uses it as well. That is what keeps an aligned invoice table
      // (whose only commas are thousands separators in the amount column) out
      // of the two-column path.
      if (minOccurrences === 1) {
        if (!firstContent || cellsOf(firstContent.text, delimiter).length < 2) continue;
      }
      const counts: number[] = [];
      for (const info of infos) {
        if (info.junk) continue;
        const fields = cellsOf(info.text, delimiter).length;
        if (fields - 1 < minOccurrences) continue;
        counts.push(fields);
      }
      if (counts.length < MIN_ROWS) continue;

      const fields = modalCount(counts);
      if (fields < 2) continue;
      const matched = counts.filter((count) => count === fields).length;
      if (matched < MIN_ROWS) continue;
      if (matched / counts.length < MATCH_RATIO) continue;

      if (
        !winner ||
        matched > winner.matched ||
        (matched === winner.matched && fields > winner.fields)
      ) {
        winner = { delimiter, fields, matched, candidates: counts.length };
      }
    }
    return winner;
  };

  // The brief's rule first: only lines that carry the delimiter at least twice
  // may vote. A two-column table has no such line, so a second pass allows a
  // single occurrence – but only after the strict pass found nothing, so a
  // padded junk line can still never outvote a real table.
  const best = vote(2) ?? vote(1);
  if (!best) return null;

  const rows: Cell[][] = [];
  const rejected: RejectedRow[] = [];
  for (const info of infos) {
    const cells = cellsOf(info.text, best.delimiter);
    const padded: Cell[] = cells.slice(0, best.fields);
    while (padded.length < best.fields) padded.push(null);

    if (info.junk) {
      rejected.push({ reason: info.junk, values: padded });
      continue;
    }
    if (cells.length <= best.fields) {
      // A row shorter than the table is a row with missing trailing cells –
      // exports drop empty cells at the end of a line all the time. It is
      // padded with nulls, never rejected and never shifted.
      rows.push(padded);
      continue;
    }
    // Wider than the table: the line cannot be aligned to these columns, so it
    // is rejected with a reason instead of being truncated.
    rejected.push({
      reason: `does not match the table structure (${cells.length} fields, expected ${best.fields})`,
      values: padded,
    });
  }

  if (rows.length < MIN_ROWS) return null;

  const label = best.delimiter === '\t' ? 'TAB' : `"${best.delimiter}"`;
  return {
    delimiter: best.delimiter,
    fields: best.fields,
    rows,
    rejected,
    consistency: best.matched / best.candidates,
    notes: [
      `delimiter chosen from content: ${label} · ${best.fields} columns · ` +
        `${best.matched}/${best.candidates} matching lines (${Math.round((best.matched / best.candidates) * 100)}%)`,
      ...(rejected.length > 0
        ? [`${rejected.length} line(s) did not fit the table structure and moved to Rejected rows`]
        : []),
    ],
  };
}
