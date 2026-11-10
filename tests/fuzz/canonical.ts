/**
 * The grader for the fuzz harness — deliberately independent of the pipeline.
 *
 * Nothing here is imported from `src/pipeline` or `src/lib`: if the grammar of
 * "the same value" lived in the code under test, a rule that merges two values
 * would also make the grader call them equal (that is exactly how `B+` folding
 * into `B` passed this harness before). The only imports are the types.
 *
 * Grading is done on the product's **download**, not on the in-memory dataset:
 * every case is exported with `toCSV` and re-parsed here, so a value the
 * exporter neutralises, mangles or drops fails the case.
 */
import type { Cell } from '../../src/types';

/** RFC 4180 parser: quoted fields, doubled quotes, CRLF/LF, a leading BOM. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const body = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const CURRENCY = /^(?:[$€£¥₹₽¢₩₪₫฿]|(?:rs\.?|inr|usd|eur|gbp|aed|sgd|aud|cad|jpy|cny)\s*)/i;

/**
 * Parse a number the way a *reader* would: grouping separators, a currency
 * prefix, a percent sign, parentheses for negatives, a trailing "/-".
 * Magnitudes ("3.2 L") are deliberately NOT parsed: the pipeline has to hand
 * back the number, not the shorthand.
 */
export function readNumber(value: string): number | null {
  let text = value.trim();
  if (text === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  text = text.replace(CURRENCY, '').trim();
  if (text.endsWith('%')) text = text.slice(0, -1).trim();
  if (text.endsWith('/-')) text = text.slice(0, -2).trim();
  text = text.replace(/\s+/g, '');
  if (/^[+-]/.test(text)) {
    if (text.startsWith('-')) negative = !negative;
    text = text.slice(1);
  }
  if (!/^\d+(?:[.,]\d+)*$/.test(text)) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  let normalized = text;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? text.replace(/\./g, '').replace(/,/g, '.') : text.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const parts = text.split(',');
    normalized = parts.length === 2 && parts[1].length !== 3 ? `${parts[0]}.${parts[1]}` : parts.join('');
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Formatting-insensitive text identity, with symbols kept.
 *
 * Case, surrounding/repeated whitespace and a separator between alphanumerics
 * are formatting. A leading or trailing symbol is not (`B+` ≠ `B`), and neither
 * is a hyphen between a letter and a digit (`Q-1` ≠ `Q1`) — those are the exact
 * shapes this harness exists to catch.
 */
export function readText(value: string): string {
  const collapsed = value.trim().replace(/\s+/g, ' ').toLowerCase();
  if (DATE_SHAPE.test(collapsed) || /^[\d\s:.,/-]+$/.test(collapsed)) return collapsed;

  // Walk the string in runs of alphanumerics and runs of everything else. A
  // separator run is formatting when it sits between two alphanumerics — unless
  // it separates a letter from a following digit, where a hyphen distinguishes
  // identifiers (Q-1 vs Q1). Leading and trailing runs are always kept: that is
  // what makes "B+", "B" and "B-" three different values here.
  const runs = collapsed.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}]+/gu) ?? [];
  const SEPARATOR_RUN = /^[\s_/;-]+$/;
  let out = '';
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index] as string;
    if (!SEPARATOR_RUN.test(run)) {
      out += run;
      continue;
    }
    const before = runs[index - 1];
    const after = runs[index + 1];
    if (!before || !after) {
      out += run;
      continue;
    }
    const lastBefore = before.slice(-1);
    const firstAfter = after.charAt(0);
    if (/\p{L}/u.test(lastBefore) && /\p{N}/u.test(firstAfter) && run.includes('-')) {
      out += run;
      continue;
    }
    // Formatting: drop the whole separator run.
  }
  return out;
}

function isBlank(value: string | Cell | null | undefined): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** Does the downloaded cell carry the ground-truth value? */
export function sameCell(expected: Cell, actual: string | null | undefined): boolean {
  if (isBlank(expected) || isBlank(actual)) return isBlank(expected) && isBlank(actual);
  const text = String(actual).trim();

  if (typeof expected === 'boolean') {
    return text.toLowerCase() === (expected ? 'true' : 'false');
  }
  if (typeof expected === 'number') {
    const parsed = readNumber(text);
    return parsed !== null && Math.abs(parsed - expected) < 0.005;
  }
  // A number on the ground-truth side that the pipeline returns as text is a
  // failure unless the number survives the round trip exactly.
  if (typeof expected === 'string' && /^-?\d+(?:\.\d+)?$/.test(expected)) {
    const parsed = readNumber(text);
    if (parsed !== null && Math.abs(parsed - Number(expected)) < 0.005) return true;
  }
  return readText(String(expected)) === readText(text);
}

/** Column-name identity for mapping the download's header back to ground truth. */
export function sameHeaderName(left: string, right: string): boolean {
  const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return fold(left) === fold(right);
}
