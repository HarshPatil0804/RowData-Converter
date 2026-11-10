import type { Cell, OverlapEntry, Reconciliation, ValueMapping } from '../types';
import { categoryKey, cleanText, isNullSentinel, mergeKey } from '../lib/strings';
import { parseNumberValue, spelledToNumber } from '../lib/numbers';

/**
 * The rest of the clean-stage rules:
 *   R4  numbers never hold text – the text moves to `<col>_note`
 *   R6  categories are clustered and reshaped per column role
 *   R7  system-generated notes move to a `system_flag` column
 *   R9  logic flags (flag only, never delete)
 *   R10 reconciliation of the parsed total against the file's own total
 */

// ------------------------------------------------------------------ R7 ----

/**
 * System-generated entries: "SYSTEM NOTE: …", "auto-generated: …". Requires
 * the machine prefix *and* a colon, so human prose never matches.
 */
const SYSTEM_RE =
  /^(?:system|server|daemon|bot|script|machine|automated|automatic|auto)(?:[\s_-]+(?:generated?|gen))?[\s_-]*(?:note|msg|message|log|entry|alert|warning|error|event|comment)?\s*:/i;

/** Rows whose value is machine output → move it out of the human column. */
export function detectSystemRows(columns: string[], rows: Cell[][]): boolean[] {
  const flags = new Array<boolean>(rows.length).fill(false);
  columns.forEach((_name, index) => {
    rows.forEach((row, rowIndex) => {
      const value = row[index];
      if (typeof value === 'string' && SYSTEM_RE.test(value.trim())) flags[rowIndex] = true;
    });
  });
  return flags;
}

/** Blank the flagged cells so the human column only holds human text. */
export function clearSystemCells(columns: string[], rows: Cell[][], systemRows: boolean[]): number {
  let cleared = 0;
  columns.forEach((_name, index) => {
    rows.forEach((row, rowIndex) => {
      if (!systemRows[rowIndex]) return;
      const value = row[index];
      if (typeof value === 'string' && SYSTEM_RE.test(value.trim())) {
        row[index] = null;
        cleared += 1;
      }
    });
  });
  return cleared;
}

// ------------------------------------------------------------------ R4 ----

// ------------------------------------------------------------------ R13 ----

/**
 * A leading "+" means phone/reference-like text (R4 keeps it as text), so it
 * never counts towards numericity – otherwise "+1 415 555 0101" would drag a
 * phone column into the number conversion. Spelled-out numbers count as
 * numeric (R13) so a column written in words is still recognised as a number
 * column and converted.
 */
function numericString(value: string): number | null {
  if (value.trimStart().startsWith('+')) return null;
  const parsed = parseNumberValue(value);
  if (parsed !== null) return parsed;
  return spelledToNumber(value);
}

/** A numeric column: at least 80% of its present values parse as numbers. */
export function isNumericColumn(values: Cell[]): boolean {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return false;
  let numeric = 0;
  for (const value of present) {
    if (typeof value === 'number') numeric += 1;
    else if (typeof value === 'string' && numericString(value) !== null) numeric += 1;
  }
  return numeric / present.length >= 0.8;
}

export interface NumericConversion {
  values: Cell[];
  notes: Cell[];
  /** Values moved out of the number column into the note column. */
  moved: number;
  /** Values rewritten as a number (currency, grouping, percent). */
  converted: number;
  /** Subset of `converted` that was spelled out in words (R13). */
  spelled: number;
}

/**
 * R4: parse every numeric value; anything that refuses to parse becomes null
 * in the number and keeps its text in `<col>_note`. Text is never left behind
 * in a numeric column.
 */
export function convertNumeric(values: Cell[]): NumericConversion {
  const out: Cell[] = [];
  const notes: Cell[] = [];
  let moved = 0;
  let converted = 0;
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
    const text = cleanText(String(value)).trim();
    if (text === '') {
      out.push(null);
      notes.push(null);
      continue;
    }
    // R13 first: spelled-out numbers become digits, then the normal parse.
    const word = parseNumberValue(text) === null ? spelledToNumber(text) : null;
    const parsed = word ?? parseNumberValue(text);
    if (parsed !== null) {
      out.push(parsed);
      notes.push(null);
      if (word !== null) {
        spelled += 1;
        converted += 1;
      } else if (!/^-?\d+(?:\.\d+)?$/.test(text.replace(/,/g, ''))) {
        converted += 1;
      }
      continue;
    }
    out.push(null);
    notes.push(text);
    moved += 1;
  }

  return { values: out, notes, moved, converted, spelled };
}

// ------------------------------------------------------------------ R6 ----

const FREE_NAME_RE = /(?:^|[_ -])(notes?|comments?|remarks?|descriptions?|messages?|messages|text|body|content|details)(?:$|[_ -])/i;
const STATUS_NAME_RE = /(?:^|[_ -])(status|state|stage|category|categories|class|tier|grade|level|priority|severity|flag)(?:$|[_ -])/i;
const LABEL_NAME_RE =
  /(?:^|[_ -])(city|cities|country|region|location|site|branch|zone|area|department|dept|division|team|group|brand|channel|segment|supplier|vendor|manufacturer|store|outlet|ward|unit|floor|ward)(?:$|[_ -])/i;

/** Free text if values are sentence-like: long, many words, or punctuated. */
function looksFreeText(values: string[]): boolean {
  if (values.length === 0) return false;
  let sentenceLike = 0;
  for (const value of values) {
    const words = value.split(/\s+/).length;
    if (words >= 5 || /[.;:]$/.test(value)) sentenceLike += 1;
  }
  return sentenceLike / values.length >= 0.3;
}

export type ColumnRole = 'status' | 'label' | 'free' | 'plain';

export function columnRole(name: string, values: string[], forceTitle: boolean): ColumnRole {
  if (FREE_NAME_RE.test(name)) return 'free';
  if (STATUS_NAME_RE.test(name)) return 'status';
  if (LABEL_NAME_RE.test(name) || forceTitle) return 'label';
  if (looksFreeText(values)) return 'free';
  return 'plain';
}

function collapse(value: string): string {
  return cleanText(value).trim().replace(/\s+/g, ' ');
}

function upperSnake(value: string): string {
  // Separators *between* alphanumerics become underscores; a leading or
  // trailing symbol is part of the value ("B+" stays "B+", "Delivered-" stays
  // "DELIVERED-"), which is what S1 is about.
  const stepped = value.replace(/([\p{L}\p{N}])[\s_/.;-]+(?=[\p{L}\p{N}])/gu, '$1_');
  return stepped.replace(/[\s]+/g, '_').toUpperCase();
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(' ');
}

export interface CategoryConversion {
  values: Cell[];
  mappings: ValueMapping[];
  conversions: number;
  /**
   * S1 – pairs/sets that differ only by a leading or trailing symbol. They are
   * never merged; each is listed here so the report can say so.
   */
  similar: { values: string[]; count: number }[];
}

/**
 * A "category" column, decided from content: few enough distinct folded
 * values that clustering them is meaningful. The invariant suite uses the
 * exact same predicate, so anything this considers a category comes out free
 * of case/space/punctuation collisions.
 */
export function isCategoryColumn(values: Cell[]): boolean {
  const strings = values.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  if (strings.length === 0) return false;
  const keys = new Set(strings.map(mergeKey));
  return keys.size <= Math.max(3, Math.floor(values.length * 0.5));
}

/**
 * R6: group values that differ only by case/spacing/punctuation, keep the most
 * frequent form as canonical, then reshape by role – UPPER_SNAKE_CASE for
 * status-like columns, Title Case for city/department/label columns, as-is
 * elsewhere.
 */
export function normalizeCategories(
  name: string,
  values: Cell[],
  forceTitle: false | boolean = false,
): CategoryConversion {
  const strings = values.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  const out = values.map((value) => (typeof value === 'string' ? collapse(value) : value));
  if (strings.length === 0) return { values: out, mappings: [], conversions: 0, similar: [] };

  // Only true categories: few distinct folded keys relative to the row count.
  // S1 – the key only absorbs case, whitespace and formatting separators, so
  // "B+", "B" and "B-" stay three values.
  const groups = new Map<string, Map<string, number>>();
  const order: string[] = [];
  for (const text of strings) {
    const form = collapse(text);
    const key = mergeKey(form);
    const bucket = groups.get(key);
    if (bucket) bucket.set(form, (bucket.get(form) ?? 0) + 1);
    else {
      groups.set(key, new Map([[form, 1]]));
      order.push(key);
    }
  }
  const maxKeys = Math.max(3, Math.floor(values.length * 0.5));
  if (groups.size > maxKeys) return { values: out, mappings: [], conversions: 0, similar: [] };

  // S1 – values that a symbol drop would merge are listed for review instead.
  const similar = new Map<string, { values: Map<string, number>; count: number }>();
  for (const text of strings) {
    const form = collapse(text);
    const loose = categoryKey(form);
    const bucket = similar.get(loose) ?? { values: new Map<string, number>(), count: 0 };
    bucket.values.set(form, (bucket.values.get(form) ?? 0) + 1);
    bucket.count += 1;
    similar.set(loose, bucket);
  }
  const similarGroups = [...similar.values()]
    .filter((group) => group.values.size > 1)
    .map((group) => ({ values: [...group.values.keys()].sort(), count: group.count }));

  const role = columnRole(name, strings, forceTitle);
  const canonical = new Map<string, string>();
  for (const key of order) {
    const bucket = groups.get(key) as Map<string, number>;
    let best = '';
    let bestCount = -1;
    for (const [form, count] of bucket) {
      if (count > bestCount) {
        best = form;
        bestCount = count;
      }
    }
    canonical.set(key, best);
  }

  const mappings: ValueMapping[] = [];
  const changed = new Map<string, number>();
  let conversions = 0;

  const mapped = (raw: string): string => {
    const form = collapse(raw);
    const key = mergeKey(form);
    const base = canonical.get(key) ?? form;
    let next = base;
    if (role === 'status') next = upperSnake(base);
    else if (role === 'label') next = titleCase(base);
    if (next !== raw) {
      conversions += 1;
      if (next !== form) changed.set(`${form}→${next}`, (changed.get(`${form}→${next}`) ?? 0) + 1);
    }
    return next;
  };

  const result = values.map((value) => (typeof value === 'string' ? mapped(value) : value));
  for (const [pair, count] of changed) {
    const [from, to] = pair.split('→');
    mappings.push({ column: name, from, to, count });
  }
  mappings.sort((a, b) => b.count - a.count);

  return { values: result, mappings, conversions, similar: similarGroups };
}

// ------------------------------------------------------------------ R9 ----

/** Statuses that mean the visit/record never happened. */
const CANCELLED_RE = /cancel|no[\s_-]?show|void|reject|fail|abort|expire/i;
/** Statuses that mean "still to come". */
const UPCOMING_RE = /schedul|booked|reserved|confirmed|planned|open/i;
/** Statuses that mean money was taken. */
const PAID_RE = /paid|settled|cleared/i;

export interface FlagSpec {
  name: string;
  values: Cell[];
  count: number;
}

function textOf(value: Cell): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, '_') : '';
}

function statusIndex(columns: string[], types: (string | null)[]): number {
  // Prefer the status column that actually describes the record lifecycle.
  const candidates = columns.map((name, index) => ({ name, index })).filter(({ name }) => STATUS_NAME_RE.test(name));
  if (candidates.length === 0) return -1;
  const measured = candidates.filter(({ index }) => types[index] === 'text');
  const pool = measured.length > 0 ? measured : candidates;
  return pool[0].index;
}

function measureIndex(columns: string[], types: (string | null)[]): number {
  const idRe = /(?:^|[_ -])(id|ids|no|num|number|code|key|ref)(?:$|[_ -])/i;
  const numeric = columns.map((name, index) => ({ name, index })).filter(
    ({ name, index }) => types[index] === 'number' && !idRe.test(name),
  );
  if (numeric.length === 0) return -1;
  const money = numeric.find(({ name }) => /fee|amount|price|cost|revenue|sales|total|value|charge|payment|balance|salary|income|profit|budget/i.test(name));
  return (money ?? numeric[0]).index;
}

/**
 * Build the R9 logic flags. Each flag is a boolean column that marks rows –
 * nothing is ever dropped because a flag is set. Columns that flag nobody are
 * reported as 0 instead of being emitted as an all-null column.
 */
export function buildLogicFlags(
  columns: string[],
  rows: Cell[][],
  types: (string | null)[],
  exportDate: string | null,
): FlagSpec[] {
  const flags: FlagSpec[] = [];
  const statusIdx = statusIndex(columns, types);
  const measureIdx = measureIndex(columns, types);
  const dateIdx = columns.findIndex((_name, index) => types[index] === 'date');
  const ageIdx = columns.findIndex((name) => /(?:^|[_ -])(age|years|yr)(?:$|[_ -])/i.test(name));
  const payIdx = columns.findIndex(
    (name, index) => index !== statusIdx && STATUS_NAME_RE.test(name) && types[index] === 'text',
  );

  const push = (name: string, values: Cell[]): void => {
    const count = values.reduce<number>((total, value) => (value === true ? total + 1 : total), 0);
    flags.push({ name, values, count });
  };

  // fee_on_cancelled_or_noshow
  if (statusIdx >= 0 && measureIdx >= 0) {
    const head = (columns[measureIdx].split('_')[0] || columns[measureIdx]).toLowerCase();
    const values = rows.map((row) => {
      const status = textOf(row[statusIdx]);
      if (!CANCELLED_RE.test(status)) return null;
      return typeof row[measureIdx] === 'number' ? true : null;
    });
    push(`${head}_on_cancelled_or_noshow`, values);
  }

  // scheduled_in_past (relative to the file's own export date)
  if (statusIdx >= 0 && dateIdx >= 0 && exportDate) {
    const values = rows.map((row) => {
      if (!UPCOMING_RE.test(textOf(row[statusIdx]))) return null;
      const date = row[dateIdx];
      if (typeof date !== 'string' || date === '') return null;
      return date < exportDate ? true : null;
    });
    push('scheduled_in_past', values);
  }

  // paid_without_fee
  if (payIdx >= 0 && measureIdx >= 0) {
    const values = rows.map((row) => {
      if (!PAID_RE.test(textOf(row[payIdx]))) return null;
      return typeof row[measureIdx] === 'number' ? null : true;
    });
    push('paid_without_fee', values);
  }

  // age_missing
  if (ageIdx >= 0) {
    const values = rows.map((row) => (row[ageIdx] === null || row[ageIdx] === undefined ? true : null));
    push('age_missing', values);
  }

  return flags;
}

// ------------------------------------------------------------------ R10 ----

const ID_NAME_RE = /(?:^|[_ -])(id|ids|no|num|number|code|key|ref)(?:$|[_ -])/i;

/** Largest number written in a summary line ("₹ 42,87,650.00" → 4287650). */
export function numberInText(text: string): number | null {
  const matches = text.match(/\d[\d,]*(?:\.\d+)?/g);
  if (!matches) return null;
  let best: number | null = null;
  for (const match of matches) {
    const parsed = parseNumberValue(match);
    if (parsed !== null && (best === null || Math.abs(parsed) > Math.abs(best))) best = parsed;
  }
  return best;
}

/** Find the file's summary/total line among the rejected rows. */
export function findReportedTotal(rejected: { reason: string; values: Cell[] }[]): {
  value: number | null;
  source: string | null;
} {
  for (const row of rejected) {
    if (row.reason !== 'summary/total line') continue;
    const text = row.values
      .filter((cell) => cell !== null && cell !== undefined)
      .map((cell) => String(cell))
      .join(' ');
    const value = numberInText(text);
    if (value !== null) return { value, source: text.trim() };
  }
  return { value: null, source: null };
}

/**
 * R10: compare the sum of the parsed column with the total the file itself
 * reports. The column is chosen by name overlap with the summary line, with
 * the largest non-id numeric sum as a fallback.
 */
export function reconcile(
  columns: string[],
  rows: Cell[][],
  types: (string | null)[],
  reported: { value: number | null; source: string | null },
): Reconciliation | null {
  const numeric = columns
    .map((name, index) => ({ name, index }))
    .filter(({ name, index }) => types[index] === 'number' && !ID_NAME_RE.test(name));
  if (numeric.length === 0) return null;

  const sumOf = (index: number): number =>
    rows.reduce<number>((total, row) => (typeof row[index] === 'number' ? total + row[index] : total), 0);

  let pick = numeric[0];
  if (reported.source) {
    const haystack = reported.source.toLowerCase();
    let bestScore = 0;
    for (const candidate of numeric) {
      let score = 0;
      for (const token of candidate.name.toLowerCase().split('_')) {
        if (token.length >= 3 && haystack.includes(token)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        pick = candidate;
      }
    }
    if (bestScore === 0) {
      pick = numeric.reduce((best, candidate) => (sumOf(candidate.index) > sumOf(best.index) ? candidate : best), numeric[0]);
    }
  } else {
    pick = numeric.reduce((best, candidate) => (sumOf(candidate.index) > sumOf(best.index) ? candidate : best), numeric[0]);
  }

  const parsed = Math.round(sumOf(pick.index) * 100) / 100;
  if (reported.value === null) {
    return {
      column: pick.name,
      parsed,
      reported: null,
      difference: null,
      source: null,
      matches: null,
    };
  }
  const reportedValue = Math.round(reported.value * 100) / 100;
  const difference = Math.round((parsed - reportedValue) * 100) / 100;
  return {
    column: pick.name,
    parsed,
    reported: reportedValue,
    difference,
    source: reported.source,
    matches: Math.abs(difference) < 0.01,
  };
}

/** Null-count per column, used by the quality report. */
export function nullCount(values: Cell[]): number {
  return values.reduce<number>((total, value) => (isNullSentinel(value) ? total + 1 : total), 0);
}

// ------------------------------------------------------------------ R17 ----

/** Item separators: "Aspirin; Paracetamol", "A + B", "tea / coffee". */
const ITEM_SPLIT_RE = /\s*[;|]\s*|\s+\+\s+|\s+\/\s+/;

export interface ItemPlan {
  /** Item count per row (null for empty cells). */
  counts: Cell[];
  /** true when the column is a multi-item column and gets `<col>_item_count`. */
  active: boolean;
  multiCells: number;
}

/** Split one cell into its items ("A; B" → [A, B]); single values stay alone. */
export function splitItems(value: string): string[] {
  const parts = value
    .split(ITEM_SPLIT_RE)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return parts.length > 0 ? parts : [value];
}

/**
 * R17 – a "multi-item" column: at least 30% of its non-empty cells hold two
 * or more items joined by ";", " + " or " / ". The cell keeps its text; a
 * companion `<col>_item_count` column records how many items each cell holds.
 * Nothing is ever exploded in place (the Explode toggle builds a second sheet).
 */
export function planItems(values: Cell[]): ItemPlan {
  const counts: Cell[] = [];
  let nonBlank = 0;
  let multi = 0;
  for (const value of values) {
    if (value === null || value === undefined || typeof value !== 'string' || value.trim() === '') {
      counts.push(null);
      continue;
    }
    nonBlank += 1;
    const parts = value
      .split(ITEM_SPLIT_RE)
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const count = Math.max(1, parts.length);
    counts.push(count);
    if (parts.length >= 2) multi += 1;
  }
  const active = nonBlank >= 4 && multi / nonBlank >= 0.3;
  return { counts, active, multiCells: multi };
}

// ------------------------------------------------------------------ R18 ----

/**
 * Ways two values of one column can be written as a combination.
 * `_` matters because R6 runs before R18: a status-role column is reshaped to
 * UPPER_SNAKE_CASE, so "Returned / Delivered" arrives here as
 * "RETURNED_DELIVERED" with the separator already gone. Splitting on `_` is
 * safe – the containment check below rejects word-internal underscores such as
 * "IN_TRANSIT" unless "IN" and "TRANSIT" are also values of the column.
 */
const OVERLAP_SEPS = ['/', '+', '&', ',', '_'];

/**
 * R18 – overlapping categories: "Cash" and "UPI" exist on their own *and*
 * as "Cash / UPI". The combination is listed for review and never merged with
 * (or split into) its parts – only the human can say which one was meant.
 */
export function findOverlaps(column: string, values: Cell[]): OverlapEntry[] {
  const present = new Set<string>();
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') present.add(collapse(value));
  }
  if (present.size < 3) return [];
  const keys = new Set([...present].map(categoryKey));

  const entries: OverlapEntry[] = [];
  for (const value of present) {
    if (!OVERLAP_SEPS.some((sep) => value.includes(sep))) continue;
    const parts = value
      .split(new RegExp(`(?:${OVERLAP_SEPS.map((sep) => sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`))
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (parts.length < 2) continue;
    const partKeys = parts.map(categoryKey);
    if (new Set(partKeys).size < 2) continue;
    if (partKeys.some((key) => !keys.has(key))) continue;
    if (partKeys.includes(categoryKey(value))) continue;
    entries.push({ column, value, parts });
  }
  return entries;
}