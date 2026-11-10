import type { Cell } from '../types';

/**
 * Values that mean "missing" in messy data. Compared after trim + lowercase.
 * R7 adds the placeholder phrases people type instead of leaving a cell blank:
 * "no extra notes", "unknown", "tbd" …
 */
const NULL_SENTINELS = new Set([
  '',
  'null',
  'n/a',
  'na',
  'n\\a',
  'nil',
  'none',
  'undefined',
  '-',
  '--',
  '#n/a',
  '#ref!',
  '#value!',
  '#div/0!',
  '#name?',
  // R7 placeholders
  'unknown',
  'unk',
  'tbd',
  '?',
  'no extra notes',
  'no notes',
  'no comments',
  'no remarks',
  'no extra comments',
  'no additional information',
  'no info',
  'nothing',
]);

/** Unicode-normalise, strip BOM/zero-width chars, unify quotes/dashes/nbsp. */
export function cleanText(input: string): string {
  let s = input.normalize('NFC');
  s = s.replace(/^\uFEFF/, '');
  s = s.replace(/[\u200B-\u200D\u2060]/g, '');
  s = s.replace(/[\u00A0\u202F\u2009]/g, ' ');
  s = s.replace(/[\u2018\u2019\u2032]/g, "'");
  s = s.replace(/[\u201C\u201D\u2033]/g, '"');
  s = s.replace(/[\u2013\u2014\u2212]/g, '-');
  s = s.replace(/\u00AD/g, '');
  // R12 – decorative wrapping quotes are stripped FIRST, before any matching
  // or clustering: '"5005"' and '5005' must reach the rules as the same value.
  // Only a *matching pair around the whole value* goes; an apostrophe inside
  // text ("don't") or an unbalanced quote is left alone.
  s = stripWrappingQuotes(s);
  return s;
}

/** Strip one matching pair of straight/curly double or single quotes. */
function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value;
  const pairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['\u201C', '\u201D'],
    ['\u201E', '"'],
  ];
  for (const [open, close] of pairs) {
    if (value.startsWith(open) && value.endsWith(close) && value.length > open.length + close.length) {
      return value.slice(open.length, value.length - close.length);
    }
  }
  return value;
}

/**
 * R6 identity for clustering two spellings of one category.
 *
 * Only formatting may merge:
 *   - letter case ("Paid" / "PAID" / "paid"),
 *   - surrounding or repeated whitespace,
 *   - a separator (space, hyphen, underscore, slash) *between alphanumerics*.
 *
 * A leading or trailing symbol is significant ("B+", "B-" and "B" are three
 * values, "A+" is not "A"), and a hyphen between a letter and a following digit
 * is significant too ("Q-1" is not "Q1", "A-1" is not "A1") because that is
 * where identifiers differ. A digit followed by a letter is formatting
 * ("10-A" = "10 A" = "10A" = "10-a").
 */
export function mergeKey(value: string): string {
  const collapsed = cleanText(value).trim().replace(/\s+/g, ' ').toLowerCase();
  let out = '';
  for (let index = 0; index < collapsed.length; index += 1) {
    const char = collapsed[index] as string;
    if (char === ' ' || char === '-' || char === '_' || char === '/') {
      const before = collapsed[index - 1] ?? '';
      const after = collapsed[index + 1] ?? '';
      const betweenAlnum = /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after);
      // letter → digit is an identifier boundary (Q-1 ≠ Q1); everything else
      // between alphanumerics is formatting.
      const identifierBoundary = /\p{L}/u.test(before) && /\p{N}/u.test(after);
      if (betweenAlnum && !identifierBoundary) continue;
    }
    out += char;
  }
  return out;
}

/**
 * Punctuation-free identity. Used for "does this value contain another value"
 * (R18) and for *detecting* pairs that a symbol drop would merge – never for
 * deciding what to merge.
 */
export function categoryKey(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function isNullSentinel(value: Cell): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return NULL_SENTINELS.has(cleanText(value).trim().toLowerCase());
  return false;
}

/** Convert any label to snake_case; returns '' when nothing usable remains. */
export function toSnakeCase(input: string): string {
  let s = cleanText(String(input)).trim().toLowerCase();
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[^\w\s]/g, ' ');
  s = s.replace(/[_\s]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) return '';
  if (/^[0-9]/.test(s)) return `col_${s}`;
  return s;
}

/** snake_case + uniqueness (name, name_2, name_3…). Empty names become col_N. */
export function standardizeNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw, index) => {
    let base = toSnakeCase(raw ?? '');
    if (!base) base = `col_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

export function uniqueItems<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

/** Stringify a cell for display / dedupe keys (deterministic). */
export function cellKey(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return cleanText(value).trim().toLowerCase();
  return String(value);
}

export function displayCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return typeof value === 'string' ? value : String(value);
}
