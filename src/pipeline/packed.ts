import type { Cell } from '../types';
import { isNullSentinel, toSnakeCase } from '../lib/strings';

/**
 * R5 – packed fields.
 *
 * Two shapes are recognised, each only when it is consistent across at least
 * 80% of the column's cells:
 *
 *   1. key=value pairs  – "patient=Pooja; age=22; city=Nashik"
 *   2. a composite pair – "orthopedics / physiotherapy", "Cardiology - Stress
 *      Test" where the column itself is labelled as a composite
 *      ("Department / Procedure"). S5 – the two halves may be joined by
 *      different separators from row to row ("North - COMPLETED" next to
 *      "Europe / completed"); the column only has to agree on *one separator
 *      per cell*, and the header names the halves.
 *
 * Nothing is split on a hunch: an 80% miss rate means the column really is a
 * single value.
 */

const MATCH_RATIO = 0.8;

/** `key=value` inside a `;`-separated cell. */
const KV_PART = /^\s*([A-Za-z][A-Za-z0-9 _-]{0,30})\s*=\s*(.+?)\s*$/;
/**
 * S5 – the small, closed set of composite separators: spaced dash/en/em dash,
 * slash, spaced pipe, spaced colon. A cell must carry exactly ONE of them.
 *
 * The spaces around the dash and the colon are what keep hyphenated names
 * ("Jean-Luc"), ISO-ish dates ("10-12-2025") and clock times ("10:30") whole.
 */
const PAIR_SEPARATORS: RegExp[] = [/\s+[-–—]\s+/, /\s*\/\s*/, /\s+\|\s+/, /\s+:\s+/];

function separatorMatches(value: string): { left: string; right: string } | null {
  const found: { index: number; length: number }[] = [];
  for (const pattern of PAIR_SEPARATORS) {
    const global = new RegExp(pattern.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = global.exec(value)) !== null) {
      found.push({ index: match.index, length: match[0].length });
      if (match[0].length === 0) global.lastIndex += 1;
    }
  }
  if (found.length !== 1) return null;
  const [only] = found as [{ index: number; length: number }];
  return { left: value.slice(0, only.index).trim(), right: value.slice(only.index + only.length).trim() };
}

/** Container suffixes: "patient_details" is the *patient's* details. */
const CONTAINER_RE = /(?:^|[_ -])(details|info|information|data|meta|profile|record)$/i;

function nonNull(values: Cell[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value === null || value === undefined || typeof value !== 'string') continue;
    const text = value.trim();
    if (text === '' || isNullSentinel(text)) continue;
    out.push(text);
  }
  return out;
}

export function kvPairs(value: string): [string, string][] {
  const parts = value.split(';');
  const out: [string, string][] = [];
  for (const part of parts) {
    const match = KV_PART.exec(part);
    if (!match) return [];
    out.push([match[1].trim(), match[2].trim()]);
  }
  return out.length >= 2 ? out : [];
}

export function splitPair(value: string): [string, string] | null {
  // A null sentinel is missing data, not a composite: "N/A" must never become
  // N + A. It is converted to null later in the clean stage.
  if (isNullSentinel(value)) return null;
  const parts = separatorMatches(value);
  if (!parts) return null;
  const { left, right } = parts;
  if (!left || !right) return null;
  // At least one half must be a word. That keeps dates ("10/12/2025"), date
  // ranges ("10 - 20") and version strings out; it still splits composites
  // whose first half is a number, such as "0 / Comics", because the second
  // half is what the column is about.
  return [left, right];
}

/**
 * Column names the key=value split would produce, or null when the column is
 * not packed. Names come from the keys themselves; the key that names the
 * source column ("patient" in "patient_details") becomes `<key>_name` so the
 * person's name is not confused with an identifier.
 */
export function detectKvNames(source: string, values: Cell[]): string[] | null {
  const texts = nonNull(values);
  if (texts.length === 0) return null;

  const keys: string[] = [];
  const seen = new Set<string>();
  let matched = 0;
  for (const text of texts) {
    const pairs = kvPairs(text);
    if (pairs.length === 0) continue;
    matched += 1;
    for (const [key] of pairs) {
      const name = toSnakeCase(key);
      if (!seen.has(name)) {
        seen.add(name);
        keys.push(name);
      }
    }
  }
  if (matched / texts.length < MATCH_RATIO || keys.length < 2) return null;

  const head = toSnakeCase(source.split(/[_ -]/)[0] ?? source);
  const composite = CONTAINER_RE.test(source);
  return keys.map((key) => (composite && key === head ? `${key}_name` : key));
}

/**
 * Column names the composite split would produce, or null. The source column
 * is itself labelled "A / B", which is what makes the split trustworthy.
 */
export function detectPairNames(source: string, values: Cell[]): string[] | null {
  const header = splitPair(source.trim());
  if (!header) return null;

  const texts = nonNull(values);
  if (texts.length === 0) return null;
  let matched = 0;
  for (const text of texts) if (splitPair(text)) matched += 1;
  if (matched / texts.length < MATCH_RATIO) return null;

  return header.map((part) => toSnakeCase(part));
}

export interface PackedSplit {
  names: string[];
  /** Values for each new column, index-aligned with `rows`. */
  columns: Cell[][];
  kind: 'kv' | 'pair' | 'paren';
}

// ------------------------------------------------------------- R16 ----

/** "Cardiology (cardiac)" → base + qualifier. No domain vocabulary. */
const PAREN_CELL_RE = /^(.{1,120}?)\s*\(([^()]{1,80})\)\s*$/;

function parenParts(value: string): [string, string] | null {
  const match = PAREN_CELL_RE.exec(value);
  if (!match) return null;
  const base = match[1].trim();
  const qualifier = match[2].trim();
  if (base === '' || qualifier === '') return null;
  // Both halves must carry words so version strings ("v1.2 (beta)" keeps
  // digits but the qualifier at least looks like language) stay honest.
  if (!/[A-Za-z]/.test(base) || !/[A-Za-z]/.test(qualifier)) return null;
  return [base, qualifier];
}

/**
 * R16 – parenthetical qualifiers: when 80%+ of a column's non-empty cells are
 * "<text> (<qualifier>)", the qualifier moves to `<col>_qualifier` and the
 * remainder stays in `<col>_base`.
 */
export function splitParensColumn(source: string, values: Cell[]): PackedSplit | null {
  const texts = nonNull(values);
  if (texts.length < 3) return null;
  let matched = 0;
  for (const text of texts) if (parenParts(text)) matched += 1;
  if (matched / texts.length < MATCH_RATIO) return null;

  const head = toSnakeCase(source) || 'value';
  const base: Cell[] = [];
  const qualifier: Cell[] = [];
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : '';
    const parts = text ? parenParts(text) : null;
    base.push(parts ? parts[0] : text === '' ? null : text);
    qualifier.push(parts ? parts[1] : null);
  }
  return { names: [`${head}_base`, `${head}_qualifier`], columns: [base, qualifier], kind: 'paren' };
}

/** Split every cell of one column. Returns null when the column is not packed. */
export function splitColumn(source: string, values: Cell[]): PackedSplit | null {
  const kvNames = detectKvNames(source, values);
  if (kvNames) {
    const buckets: Cell[][] = kvNames.map(() => []);
    for (const value of values) {
      const text = typeof value === 'string' ? value.trim() : '';
      const pairs = text ? kvPairs(text) : [];
      // Keys are looked up by their snake_case form: detectKvNames returns
      // snake names, while the cell carries the raw key ("Unit Price").
      const map = new Map(pairs.map(([key, raw]) => [toSnakeCase(key), raw]));
      kvNames.forEach((name, index) => {
        // `<key>_name` stores the value of plain `key`.
        const rawKey = name.endsWith('_name') ? name.slice(0, -5) : name;
        buckets[index].push(map.get(rawKey) ?? null);
      });
    }
    return { names: kvNames, columns: buckets, kind: 'kv' };
  }

  const pairNames = detectPairNames(source, values);
  if (pairNames) {
    const left: Cell[] = [];
    const right: Cell[] = [];
    for (const value of values) {
      const text = typeof value === 'string' ? value.trim() : '';
      const pair = text ? splitPair(text) : null;
      // A cell without a composite separator keeps its whole value in the first
      // half instead of being emptied – losing it would be silent data loss.
      left.push(pair ? pair[0] : text === '' || isNullSentinel(text) ? null : text);
      right.push(pair ? pair[1] : null);
    }
    return { names: pairNames, columns: [left, right], kind: 'pair' };
  }

  return splitParensColumn(source, values);
}