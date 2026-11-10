/**
 * Tolerant, per-cell typing (T1–T5) and the text normalisations (N1–N3).
 *
 * The decisions here are made from the column's own values — counts, ratios,
 * recurring tokens, medians — never from a column name, a file name or a
 * specific value. Every threshold lives in `DEFAULT_TUNING` and is exported so
 * the fuzz harness can sweep four values per threshold and show the accuracy
 * does not hinge on one of them.
 */
import type { Cell } from '../types';
import { cleanText, isNullSentinel } from '../lib/strings';
import { parseNumberValue, spelledToNumber } from '../lib/numbers';
import { excelSerialToIso, looksLikeDate, parseDateValue } from '../lib/dates';

export interface Tuning {
  /** Share of a column's present values that must parse before the column takes a type. */
  numericMajority: number;
  dateMajority: number;
  booleanMajority: number;
  /** Share of values that must be email-shaped before the column is normalised. */
  emailShare: number;
  /** Share of values that must be phone-shaped. */
  phoneShare: number;
  /** Share of fraction-like cells that must share one denominator. */
  fractionShare: number;
  /** Share of non-null cells an affix must appear in to count as a unit. */
  unitShare: number;
  /** Most distinct unit words a column may have. */
  unitMax: number;
  /** Share of cells that must parse once the unit is stripped. */
  unitNumeric: number;
  /** A magnitude-suffixed value must sit within this factor of the column median. */
  magnitudeFactor: number;
}

export const DEFAULT_TUNING: Tuning = {
  numericMajority: 0.6,
  dateMajority: 0.6,
  booleanMajority: 0.9,
  emailShare: 0.9,
  phoneShare: 0.7,
  fractionShare: 0.9,
  unitShare: 0.05,
  unitMax: 8,
  unitNumeric: 0.9,
  magnitudeFactor: 100,
};

export type TuningOverride = Partial<Tuning>;

export interface ColumnPlan {
  values: Cell[];
  /** Original text of cells that could not be parsed (null where parsed). */
  notes: Cell[];
  /** Cells rewritten into the column's type. */
  converted: number;
  /** Cells that could not be parsed and were moved to the note column. */
  moved: number;
  /** Human-readable description, e.g. "currency", "unit 'hrs'", "Excel serial". */
  kinds: string[];
  /** Unit words the column uses, when any. */
  units?: string[];
  /** Magnitude suffixes applied, when any. */
  magnitudes?: string[];
  /** Denominator of a score-fraction column, when the plan is a fraction. */
  denominator?: number;
  /** Cells written out in words that became digits (R13). */
  spelled?: number;
}

// --------------------------------------------------------------- numbers ----

const CURRENCY_SYMBOLS = /^[$\u20ac\u00a3\u00a5\u20b9\u20bd\u00a2\u20a9\u20aa\u20ab\u0e3f]\s*/;
/** "Rs.12231.91" and "INR 1,200" are both currency prefixes. */
const CURRENCY_WORDS = /^(?:rs\.?\s*|inr\s*|usd\s*|eur\s*|gbp\s*|aed\s*|sgd\s*|aud\s*|cad\s*|jpy\s*|cny\s*|rupees?\s*)/i;

/** "k" thousands, "L"/lakh 100 000, "M"/million 1 000 000, "cr"/crore 10 000 000. */
const MAGNITUDES: { re: RegExp; factor: number; label: string }[] = [
  { re: /^(?:crores?|cr)\.?$/i, factor: 10_000_000, label: 'cr' },
  { re: /^(?:lakhs?|lacs?)$/i, factor: 100_000, label: 'lakh' },
  { re: /^(?:mn|million)$/i, factor: 1_000_000, label: 'million' },
  { re: /^(?:bn|billion)$/i, factor: 1_000_000_000, label: 'billion' },
  { re: /^k$/i, factor: 1_000, label: 'k' },
  { re: /^l$/i, factor: 100_000, label: 'lakh' },
  { re: /^m$/i, factor: 1_000_000, label: 'million' },
];

/** Trailing period / rate suffixes that carry no value. */
const PERIOD_SUFFIX = /(?:\s*(?:\/|\bper\b)\s*(?:month|year|annum|week|day|hour|unit|piece|pc|kg|km|item)|\.?\/-)$/i;
const RATE_SYMBOL = /(?:\s*(?:p\.?a\.?|per\s+annum|pm|pcm))$/i;

interface AffixSplit {
  number: string;
  unit?: string;
  magnitude?: { factor: number; label: string };
  period?: boolean;
  currency?: boolean;
}

/**
 * Split a formatted number into its numeric core and its affixes.
 * A single-letter trailing token is only treated as a unit/magnitude when it is
 * separated from the digits (`18 h`, `3 L`) — `3M`, `A1` and `B12` stay codes.
 */
export function splitAffixes(raw: string, units: ReadonlySet<string>): AffixSplit | null {
  let s = cleanText(raw).trim();
  if (s === '') return null;

  let currency = false;
  if (CURRENCY_SYMBOLS.test(s)) {
    currency = true;
    s = s.replace(CURRENCY_SYMBOLS, '');
  } else if (CURRENCY_WORDS.test(s)) {
    currency = true;
    s = s.replace(CURRENCY_WORDS, '');
  }
  s = s.trim();

  let period = false;
  if (PERIOD_SUFFIX.test(s)) {
    period = true;
    s = s.replace(PERIOD_SUFFIX, '');
  } else if (RATE_SYMBOL.test(s)) {
    period = true;
    s = s.replace(RATE_SYMBOL, '');
  }
  s = s.trim();

  let unit: string | undefined;
  let magnitude: AffixSplit['magnitude'];

  const trailing = /([\p{L}][\p{L}.]{0,9})$/u.exec(s);
  if (trailing) {
    const token = trailing[1].replace(/\.$/, '');
    const separated = /\s[^\s]*$/.test(s.slice(0, trailing.index)) || trailing.index === 0;
    const magnitudeHit = MAGNITUDES.find((entry) => entry.re.test(token));
    const unitHit = units.has(token.toLowerCase());
    if (magnitudeHit && (token.length > 1 || separated || units.has(token.toLowerCase()))) {
      magnitude = { factor: magnitudeHit.factor, label: magnitudeHit.label };
      s = s.slice(0, trailing.index);
    } else if (unitHit && (token.length > 1 || separated)) {
      unit = token.toLowerCase();
      s = s.slice(0, trailing.index);
    }
  }

  s = s.trim();
  // A leading word unit ("hrs 18") is only a unit when the column says so.
  const leading = /^([\p{L}][\p{L}.]{0,9})\s+/u.exec(s);
  if (leading && units.has(leading[1].replace(/\.$/, '').toLowerCase())) {
    unit = leading[1].replace(/\.$/, '').toLowerCase();
    s = s.slice(leading[0].length);
  }
  s = s.trim();
  if (s === '') return null;
  if (/[\p{L}]/u.test(s.replace(/[eE][+-]?\d+$/, ''))) return null;
  return { number: s, unit, magnitude, period, currency };
}

function numericCore(text: string): number | null {
  return parseNumberValue(text);
}

export interface NumericCell {
  value: number;
  converted: boolean;
  unit?: string;
  magnitude?: string;
  currency: boolean;
}

/** Parse one cell with the column's discovered units and magnitudes. */
export function parseNumericCell(
  raw: Cell,
  units: ReadonlySet<string>,
  magnitudes: ReadonlySet<string>,
): NumericCell | null {
  if (typeof raw === 'number') return { value: raw, converted: false, currency: false };
  if (raw === null || raw === undefined) return null;
  const text = cleanText(String(raw)).trim();
  if (text === '') return null;
  if (text.startsWith('+')) return null; // phone / reference, never a number
  const split = splitAffixes(text, units);
  if (!split) return null;
  if (split.magnitude && !magnitudes.has(split.magnitude.label)) return null;
  if (split.unit && !units.has(split.unit)) return null;
  const base = numericCore(split.number);
  if (base === null) return null;
  const value = split.magnitude ? base * split.magnitude.factor : base;
  return {
    value,
    converted: value !== base || text !== String(base) || Boolean(split.currency) || Boolean(split.unit),
    unit: split.unit,
    magnitude: split.magnitude?.label,
    currency: Boolean(split.currency),
  };
}

/** Candidate affix words in one value, with whether they sat next to a number. */
export function affixCandidates(raw: string): string[] {
  const text = cleanText(raw).trim();
  if (text === '' || /^\d+(?:\.\d+)?$/.test(text)) return [];
  const out: string[] = [];
  const trailing = /([\p{L}][\p{L}]{1,9})\.?$/u.exec(text);
  if (trailing) out.push(trailing[1].toLowerCase());
  const leading = /^([\p{L}][\p{L}]{1,9})\.?\s+/u.exec(text);
  if (leading) out.push(leading[1].toLowerCase());
  const single = /(\d)\s([\p{L}])\s*$/u.exec(text);
  if (single?.[2]) out.push(single[2].toLowerCase());
  return out;
}

/**
 * T2 – units are discovered, not listed: a word next to a number that recurs in
 * at least `unitShare` of the non-null cells, with at most `unitMax` distinct
 * words, and at least `unitNumeric` of the cells numeric once it is stripped.
 */
export function discoverUnits(values: Cell[], tuning: Tuning): string[] {
  const texts = values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => cleanText(value).trim())
    .filter((text) => text !== '');
  if (texts.length < 3) return [];
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const word of affixCandidates(text)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const eligible = [...counts.entries()]
    .filter(([word, count]) => count / texts.length >= tuning.unitShare && !/^\d+$/.test(word))
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
    .map(([word]) => word);
  if (eligible.length === 0 || eligible.length > tuning.unitMax) return [];

  // Every candidate must leave the column numeric.
  const kept: string[] = [];
  for (const word of eligible) {
    const units = new Set([word]);
    let parsed = 0;
    let present = 0;
    for (const value of values) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && cleanText(value).trim() === '') continue;
      present += 1;
      const split = typeof value === 'string' ? splitAffixes(value, units) : null;
      if (split && numericCore(split.number) !== null) parsed += 1;
      else if (typeof value === 'number') parsed += 1;
    }
    if (present > 0 && parsed / present >= tuning.unitNumeric) kept.push(word);
  }
  return kept.slice(0, tuning.unitMax);
}

/** Magnitude suffixes actually present, in a column that is otherwise numeric. */
export function discoverMagnitudes(
  values: Cell[],
  units: ReadonlySet<string>,
  tuning: Tuning,
): Set<string> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const split = splitAffixes(value, units);
    if (split?.magnitude) counts.set(split.magnitude.label, (counts.get(split.magnitude.label) ?? 0) + 1);
  }
  const labels = new Set<string>();
  for (const [label, count] of counts) {
    // A suffix used once is a code ("3M"), not a column convention.
    if (count >= 3) labels.add(label);
  }
  if (labels.size === 0) return labels;

  // Consistency: a scaled value must sit within `magnitudeFactor` of the median
  // of the column's plain numbers, or the suffix was not a magnitude at all.
  const plain: number[] = [];
  for (const value of values) {
    if (typeof value === 'number') plain.push(value);
    else if (typeof value === 'string') {
      const split = splitAffixes(value, units);
      if (split && !split.magnitude) {
        const parsed = numericCore(split.number);
        if (parsed !== null) plain.push(parsed);
      }
    }
  }
  if (plain.length < 3) return new Set<string>();
  plain.sort((a, b) => a - b);
  const median = plain[Math.floor(plain.length / 2)] as number;
  const scaled: number[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const split = splitAffixes(value, units);
    if (!split?.magnitude || !labels.has(split.magnitude.label)) continue;
    const parsed = numericCore(split.number);
    if (parsed !== null) scaled.push(parsed * split.magnitude.factor);
  }
  if (scaled.length === 0) return new Set<string>();
  const consistent =
    median !== 0 &&
    scaled.every((value) => value <= Math.abs(median) * tuning.magnitudeFactor && value >= Math.abs(median) / tuning.magnitudeFactor);
  return consistent ? labels : new Set<string>();
}

/** T1/T2/T5 – plan a numeric column cell by cell. */
export function planNumeric(values: Cell[], tuning: Tuning): ColumnPlan | null {
  const units = new Set(discoverUnits(values, tuning));
  const magnitudes = discoverMagnitudes(values, units, tuning);
  const out: Cell[] = [];
  const notes: Cell[] = [];
  const kinds = new Set<string>();
  let converted = 0;
  let moved = 0;
  let spelled = 0;

  for (const value of values) {
    if (value === null || value === undefined) {
      out.push(null);
      notes.push(null);
      continue;
    }
    if (typeof value === 'number') {
      out.push(value);
      notes.push(null);
      continue;
    }
    const parsed = parseNumericCell(value, units, magnitudes);
    if (parsed === null && typeof value === 'string') {
      // R13 – number words are a number form like any other.
      const word = spelledToNumber(cleanText(value).trim());
      if (word !== null) {
        out.push(word);
        notes.push(null);
        converted += 1;
        spelled += 1;
        continue;
      }
    }
    if (parsed === null) {
      const text = cleanText(String(value)).trim();
      out.push(null);
      notes.push(text === '' ? null : text);
      if (text !== '') moved += 1;
      continue;
    }
    out.push(parsed.value);
    notes.push(null);
    // Count every value that was not already a plain number: currency, unit,
    // magnitude, grouping or a percent sign.
    const text = cleanText(String(value)).trim();
    const plain = /^-?\d+(?:\.\d+)?$/.test(text.replace(/,/g, ''));
    if (!plain || parsed.magnitude || parsed.unit || parsed.currency) converted += 1;
    if (parsed.currency) kinds.add('currency affix');
    if (parsed.unit) kinds.add(`unit "${parsed.unit}"`);
    if (parsed.magnitude) kinds.add(`magnitude "${parsed.magnitude}"`);
  }

  if (units.size > 0) kinds.add(`units ${[...units].join(', ')}`);
  if (spelled > 0) kinds.add('spelled number');
  return {
    values: out,
    notes,
    converted,
    moved,
    kinds: [...kinds],
    units: [...units],
    magnitudes: [...magnitudes],
    spelled,
  };
}

// ---------------------------------------------------------------- dates -----

/** A 5-digit number is only a date when the column is already a date column. */
const SERIAL_MIN = 20000; // 1954-10-03
const SERIAL_MAX = 80000; // 2119-01-05

/** T3 – Excel serials and date-times inside a column that is mostly dates. */
export function planDates(values: Cell[], tuning: Tuning): ColumnPlan | null {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return null;
  let dateLike = 0;
  let serial = 0;
  for (const value of present) {
    if (typeof value === 'number') {
      if (Number.isInteger(value) && value >= SERIAL_MIN && value <= SERIAL_MAX) serial += 1;
      continue;
    }
    if (typeof value !== 'string') continue;
    if (parseDateValue(value) !== null || isSerialText(value)) {
      dateLike += 1;
      if (isSerialText(value)) serial += 1;
    }
  }
  // `dateLike` already counts serials, so it is the whole share of date evidence.
  const ratio = dateLike / present.length;
  if (ratio < tuning.dateMajority || serial === 0) return null;

  const out: Cell[] = [];
  const notes: Cell[] = [];
  const kinds = new Set<string>();
  let converted = 0;
  let moved = 0;
  for (const value of values) {
    if (value === null || value === undefined) {
      out.push(null);
      notes.push(null);
      continue;
    }
    if (typeof value === 'number' && Number.isInteger(value) && value >= SERIAL_MIN && value <= SERIAL_MAX) {
      const iso = excelSerialToIso(value);
      if (iso) {
        out.push(iso);
        notes.push(null);
        converted += 1;
        kinds.add('Excel serial (1900 system)');
        continue;
      }
    }
    if (typeof value === 'string' && isSerialText(value)) {
      const iso = excelSerialToIso(Number(value.trim()));
      if (iso) {
        out.push(iso);
        notes.push(null);
        converted += 1;
        kinds.add('Excel serial (1900 system)');
        continue;
      }
    }
    if (typeof value === 'string') {
      const iso = parseDateValue(value);
      if (iso !== null) {
        out.push(iso);
        notes.push(null);
        converted += 1;
        if (/[T ]\d{1,2}:\d{2}/.test(value) || /\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?/i.test(value)) kinds.add('date-time');
        continue;
      }
      out.push(null);
      notes.push(cleanText(value).trim());
      moved += 1;
      continue;
    }
    out.push(null);
    notes.push(String(value));
    moved += 1;
  }

  if (converted === 0) return null;
  return { values: out, notes, converted, moved, kinds: [...kinds] };
}

export function isSerialText(value: string): boolean {
  const text = value.trim();
  if (!/^\d{5}(?:\.\d+)?$/.test(text)) return false;
  const serial = Number(text);
  return serial >= SERIAL_MIN && serial <= SERIAL_MAX;
}

// ------------------------------------------------------------ fractions -----

const FRACTION_RE = /^\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*$/;

/**
 * T4 – scores written "18/20". Only when at least `fractionShare` of the
 * fraction-like cells share one denominator and no numerator exceeds it; the
 * value becomes the numerator, the denominator is reported, the original text
 * is kept in `<col>_note`. Dates ("3/4") and ratios in prose never qualify.
 */
export function planFractions(values: Cell[], tuning: Tuning): ColumnPlan | null {
  const present = values.filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
  if (present.length < 4) return null;
  let fractionCells = 0;
  const denominators = new Map<number, number>();
  for (const value of present) {
    if (typeof value !== 'string') continue;
    const match = FRACTION_RE.exec(value);
    if (!match) continue;
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    if (denominator < 2 || numerator > denominator) continue;
    fractionCells += 1;
    denominators.set(denominator, (denominators.get(denominator) ?? 0) + 1);
  }
  // "at least 90% of fraction-like cells share one denominator": the share is
  // measured among the fraction-shaped cells. They need not be the whole
  // column, but the column must be scores and numbers — a column of words (or
  // of dates such as 3/4) has no business being rewritten here.
  if (fractionCells < 4) return null;
  let numericCells = 0;
  for (const value of present) {
    if (typeof value === 'number') numericCells += 1;
    else if (typeof value === 'string' && !FRACTION_RE.test(value) && parseNumberValue(value) !== null) numericCells += 1;
  }
  if ((fractionCells + numericCells) / present.length < 0.8) return null;
  const [denominator, count] = [...denominators.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  if (denominator < 2 || count / fractionCells < tuning.fractionShare) return null;

  const out: Cell[] = [];
  const notes: Cell[] = [];
  let converted = 0;
  let moved = 0;
  for (const value of values) {
    if (typeof value === 'string') {
      const match = FRACTION_RE.exec(value);
      if (match && Number(match[2]) === denominator && Number(match[1]) <= denominator) {
        out.push(Number(match[1]));
        notes.push(cleanText(value).trim());
        converted += 1;
        continue;
      }
      if (value.trim() !== '') {
        // A plain number in a score column is still a score.
        const numeric = parseNumberValue(value);
        if (numeric !== null) {
          out.push(numeric);
          notes.push(null);
          converted += 1;
          continue;
        }
        out.push(null);
        notes.push(cleanText(value).trim());
        moved += 1;
        continue;
      }
    }
    if (typeof value === 'number') {
      out.push(value);
      notes.push(null);
      continue;
    }
    out.push(null);
    notes.push(null);
  }
  return { values: out, notes, converted, moved, kinds: ['score fraction'], denominator };
}

// ------------------------------------------------------------- booleans -----

const BOOLEAN_FAMILIES: Record<string, boolean> = {
  y: true, n: false,
  yes: true, no: false,
  true: true, false: false,
  t: true, f: false,
  '1': true, '0': false,
  on: true, off: false,
};

const FAMILY_OF: Record<string, string> = {
  y: 'y/n', n: 'y/n',
  yes: 'yes/no', no: 'yes/no',
  true: 'true/false', false: 'true/false',
  t: 't/f', f: 't/f',
  '1': '1/0', '0': '1/0',
  on: 'on/off', off: 'on/off',
};

/**
 * N1 – one vocabulary family across the whole column becomes a boolean type.
 * A column that mixes "yes" with unrelated words is not a boolean family and is
 * left as text.
 */
export function booleanFamily(values: Cell[]): { family: string; values: Cell[] } | null {
  const present = values.filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
  if (present.length < 3) return null;
  const families = new Set<string>();
  const out: Cell[] = [];
  let sawTrue = false;
  let sawFalse = false;
  for (const value of values) {
    if (value === null || value === undefined) {
      out.push(null);
      continue;
    }
    if (typeof value === 'boolean') {
      out.push(value);
      families.add('true/false');
      sawTrue ||= value;
      sawFalse ||= !value;
      continue;
    }
    const key = cleanText(String(value)).trim().toLowerCase().replace(/\.$/, '');
    const family = FAMILY_OF[key];
    if (family === undefined) return null;
    families.add(family);
    const bool = BOOLEAN_FAMILIES[key] as boolean;
    sawTrue ||= bool;
    sawFalse ||= !bool;
    out.push(bool);
  }
  if (families.size !== 1) return null;
  if (!sawTrue || !sawFalse) return null;
  return { family: [...families][0] as string, values: out };
}

// --------------------------------------------------------------- emails -----

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function isEmail(text: string): boolean {
  return EMAIL_RE.test(text.trim());
}

/** One cell of a boolean-typed column, from any vocabulary family. */
export function toBooleanCell(value: Cell): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  const key = cleanText(String(value)).trim().toLowerCase().replace(/\.$/, '');
  return FAMILY_OF[key] === undefined ? null : (BOOLEAN_FAMILIES[key] as boolean);
}

/** N2 – trim + lowercase when at least `share` of the column is email-shaped. */
export function planEmails(values: Cell[], tuning: Tuning): ColumnPlan | null {
  const present = values.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  if (present.length < 3) return null;
  const shaped = present.filter(isEmail).length;
  if (shaped / present.length < tuning.emailShare) return null;
  let converted = 0;
  const out = values.map((value) => {
    if (typeof value !== 'string' || value.trim() === '') return value;
    const next = value.trim().toLowerCase();
    if (next !== value) converted += 1;
    return next;
  });
  return { values: out, notes: values.map(() => null), converted, moved: 0, kinds: ['email'] };
}

// --------------------------------------------------------------- phones -----

function digitsOf(text: string): string {
  return text.replace(/[^\d]/g, '');
}

export interface PhoneShape {
  ok: boolean;
  /** true when the value carried an international prefix (+ or 00). */
  international: boolean;
  /** true when the value carried a national trunk "0". */
  trunk: boolean;
  digits: string;
  /** First written group of an international number, when it looks like a code. */
  code?: string | null;
}

export function parsePhone(text: string): PhoneShape {
  const value = text.trim();
  const cleaned = value.replace(/[\s().-]/g, '');
  if (!/^(?:\+|00)?\d{7,15}$/.test(cleaned)) return { ok: false, international: false, trunk: false, digits: '' };
  const international = cleaned.startsWith('+') || cleaned.startsWith('00');
  const body = cleaned.replace(/^\+/, '').replace(/^00/, '');
  const digits = digitsOf(body);
  if (digits.length < 7 || digits.length > 15) return { ok: false, international: false, trunk: false, digits: '' };
  // The country code is the first written group ("+1 (415) 555-0101" → "1"):
  // the grouping is how the exporting system itself separated the code.
  const groups = value.replace(/^\s*(?:\+|00)/, '').split(/[^\d]+/).filter(Boolean);
  const code = international && groups.length >= 3 && (groups[0] as string).length <= 3 ? (groups[0] as string) : null;
  const trunk = !international && digits.startsWith('0');
  return { ok: true, international, trunk, digits, code };
}

export interface PhoneResult extends ColumnPlan {
  countryCode: string | null;
  flagged: number;
}

/**
 * N3 – when at least `share` of a column is phone-shaped: strip separators,
 * convert 00 to +. When every number shares one country code (or none) the
 * national number is written as digits and the code is reported; when the codes
 * differ each keeps "+<digits>" and the numbers with no code are flagged.
 */
export function planPhones(values: Cell[], tuning: Tuning): PhoneResult | null {
  const present = values.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  if (present.length < 3) return null;
  const parsed = present.map((text) => parsePhone(text));
  if (parsed.filter((entry) => entry.ok).length / present.length < tuning.phoneShare) return null;

  const international = parsed.filter((entry) => entry.ok && entry.international);
  const codes = new Set(international.map((entry) => entry.code ?? null));
  const everyInternational = international.length === parsed.filter((entry) => entry.ok).length;
  let countryCode: string | null = null;
  if (everyInternational && international.length > 0 && codes.size === 1 && !codes.has(null)) {
    countryCode = [...codes][0] as string;
  }
  const allShared = countryCode !== null;
  const noneCoded = international.length === 0;

  let converted = 0;
  let flagged = 0;
  const out = values.map((value) => {
    if (typeof value !== 'string' || value.trim() === '') return value;
    const shape = parsePhone(value);
    if (!shape.ok) {
      flagged += 1;
      return value;
    }
    let next: string;
    if (allShared && countryCode && shape.international && shape.digits.startsWith(countryCode)) {
      next = shape.digits.slice(countryCode.length);
    } else if (noneCoded) {
      next = shape.digits.replace(/^0+/, '');
    } else if (shape.international) {
      next = `+${shape.digits}`;
    } else {
      next = shape.digits.replace(/^0+/, '');
      flagged += 1;
    }
    if (next !== value) converted += 1;
    return next;
  });

  return {
    values: out,
    notes: values.map(() => null),
    converted,
    moved: 0,
    kinds: ['phone'],
    countryCode: allShared ? countryCode : null,
    flagged,
  };
}

/**
 * The column's type, decided by content alone: one boolean vocabulary family,
 * a score-fraction column, a mostly-date column, a mostly-numeric column, or
 * text. The ratio thresholds are the swept knobs in `Tuning`.
 */
export interface TypeDecision {
  type: 'number' | 'date' | 'boolean' | 'text';
  /** Share of present values that parsed into that type (1 for text). */
  rate: number;
  family?: string;
  denominator?: number;
  numeric?: ColumnPlan;
}

export function decideType(values: Cell[], tuning: Tuning): TypeDecision {
  const present = values.filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
  if (present.length === 0) return { type: 'text', rate: 0 };

  const family = booleanFamily(values);
  if (family) {
    // `booleanFamily` already refuses mixed vocabularies; the ratio knob keeps
    // a column with a couple of odd forms a boolean (they become null + note).
    const clean = values.filter((value) => value !== null && value !== undefined);
    const matches = clean.filter((value) => {
      if (typeof value === 'boolean') return true;
      const key = String(value).trim().toLowerCase().replace(/\.$/, '');
      return FAMILY_OF[key] === family.family;
    }).length;
    if (clean.length > 0 && matches / clean.length >= tuning.booleanMajority) {
      return { type: 'boolean', rate: matches / clean.length, family: family.family };
    }
  }

  const fraction = planFractions(values, tuning);
  if (fraction) return { type: 'number', rate: 1, denominator: fraction.denominator };

  // A date column is recognised from the values themselves. Excel serials are
  // a *minority* form that only qualifies inside a column that is otherwise
  // dates — a column of 5-digit ids or amounts never gets there.
  let dateLike = 0;
  let serials = 0;
  for (const value of present) {
    if (typeof value !== 'string') continue;
    if (parseDateValue(value) !== null || looksLikeDate(value)) dateLike += 1;
    else if (/^\d{5}(?:\.\d+)?$/.test(value.trim())) {
      const serial = Number(value.trim());
      if (serial >= 20000 && serial <= 80000) serials += 1;
    }
  }
  // The threshold is the share of the *column* that is date evidence, not the
  // share of dates among date-ish values: a column that is two-thirds dates and
  // one-third serials is entirely date evidence and must not become text just
  // because the serials outvote the other forms. A column of five-digit ids has
  // no real dates at all, and serials may never outnumber them, so it stays out.
  const dated = dateLike + serials;
  if (dateLike > 0 && serials <= dateLike && dated / present.length >= tuning.dateMajority) {
    return { type: 'date', rate: dated / present.length };
  }

  const numeric = planNumeric(values, tuning);
  if (numeric) {
    const parsed = numeric.values.filter((value) => value !== null).length;
    if (parsed / present.length >= tuning.numericMajority) {
      return { type: 'number', rate: parsed / present.length, numeric };
    }
  }

  // A plain number column (no affixes) still has to clear the same majority.
  let plain = 0;
  for (const value of present) {
    if (typeof value === 'number') plain += 1;
    else if (
      typeof value === 'string' &&
      !value.trimStart().startsWith('+') &&
      parseNumberValue(value) !== null
    ) {
      plain += 1;
    }
  }
  if (plain / present.length >= tuning.numericMajority) {
    return { type: 'number', rate: plain / present.length };
  }

  return { type: 'text', rate: 1 };
}

/** Placeholder words that recur in an otherwise numeric column (T5). */
export function recurringWords(values: Cell[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = cleanText(value).trim();
    if (!/^[\p{L}][\p{L}\s.'-]{0,20}$/u.test(text)) continue;
    if (isNullSentinel(text)) continue;
    counts.set(text.toLowerCase(), (counts.get(text.toLowerCase()) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count >= 2).map(([word]) => word);
}
