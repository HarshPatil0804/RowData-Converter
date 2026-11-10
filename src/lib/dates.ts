import type { Cell } from '../types';
import { cleanText } from './strings';

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9,
  sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 100) year += 2000;
  if (year < 1500 || year > 2999) return null;
  if (day > daysInMonth(year, month)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Parse a date-ish value into ISO-8601.
 * - date only → YYYY-MM-DD
 * - date + time without offset → YYYY-MM-DDTHH:mm:ss
 * - date + time with Z/offset → real UTC ISO string
 * Returns null when the value is not a date. Ambiguous day/month pairs
 * (e.g. 03/04/2024) are read day-first.
 */
export function parseDateValue(value: Cell): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return null;

  const s = cleanText(value).trim();
  if (!s || s.length > 40) return null;

  // ISO-ish: 2024-01-05, 2024-01-05 10:30, 2024-01-05T10:30:00Z, 2024-01-05T10:30:00+05:30
  const iso = s.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/,
  );
  if (iso) {
    const [, y, mo, d, hh, mm, , off] = iso;
    const date = buildDate(Number(y), Number(mo), Number(d));
    if (!date) return null;
    if (!hh) return date;
    // ISO 8601 to the minute (T3).
    const time = `${pad(Number(hh))}:${pad(Number(mm))}`;
    if (!off) return `${date}T${time}`;
    if (off === 'Z') return `${date}T${time}Z`;
    const normalized = off.length === 5 ? `${off.slice(0, 3)}:${off.slice(3)}` : off;
    return `${date}T${time}${normalized}`;
  }

  // 2024/01/05
  const slashIso = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (slashIso) {
    const date = buildDate(Number(slashIso[1]), Number(slashIso[2]), Number(slashIso[3]));
    if (!date) return null;
    if (!slashIso[4]) return date;
    return `${date}T${pad(Number(slashIso[4]))}:${pad(Number(slashIso[5]))}`;
  }

  // T3(b) – a clock time on the end of any other date shape:
  // "05/01/2024 14:30", "5 Jan 2024 2:30 PM", "01-05-24 9:15 am".
  const clock = splitClock(s);
  if (clock) {
    const base = parseDateValue(clock.datePart);
    if (base) return `${base}T${clock.time}`;
  }

  // 05/01/2024 · 05-01-2024 · 05.01.2024  (day-first unless the 2nd part > 12)
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (dmy) {
    let first = Number(dmy[1]);
    let second = Number(dmy[2]);
    if (first > 12 && second <= 12) {
      // definitely day-first
    } else if (second > 12 && first <= 12) {
      // definitely month-first (e.g. 3/25/2024)
      [first, second] = [second, first];
    } else if (second > 12 && first > 12) {
      return null;
    } else {
      // ambiguous → day-first (documented in README)
    }
    const date = buildDate(Number(dmy[3]), second, first);
    if (!date) return null;
    return date;
  }

  // Month-name dates: Jan 5, 2024 / 5 Jan 2024 / 05-Jan-2024 / Jan 2024
  const lower = s.replace(/,/g, '').toLowerCase();
  const named = lower.match(/^([a-z]{3,9})\s+(\d{1,2})\s+(\d{4})$/);
  if (named && MONTHS[named[1]]) {
    const date = buildDate(Number(named[3]), MONTHS[named[1]], Number(named[2]));
    if (date) return date;
  }
  const named2 = lower.match(/^(\d{1,2})\s+([a-z]{3,9})\s+(\d{4})$/);
  if (named2 && MONTHS[named2[2]]) {
    const date = buildDate(Number(named2[3]), MONTHS[named2[2]], Number(named2[1]));
    if (date) return date;
  }
  const named3 = lower.match(/^(\d{1,2})[- ]([a-z]{3,9})[- ](\d{4})$/);
  if (named3 && MONTHS[named3[2]]) {
    const date = buildDate(Number(named3[3]), MONTHS[named3[2]], Number(named3[1]));
    if (date) return date;
  }
  const monthYear = lower.match(/^([a-z]{3,9})\s+(\d{4})$/);
  if (monthYear && MONTHS[monthYear[1]]) {
    const date = buildDate(Number(monthYear[2]), MONTHS[monthYear[1]], 1);
    if (date) return date;
  }

  return null;
}

export function looksLikeDate(value: string): boolean {
  const text = value.trim();
  if (text === '') return false;
  // Any recognised shape counts – resolveDates owns the actual conversion and
  // keeps what it cannot prove (principle 2) instead of nulling it.
  if (datePatternKey(text) !== null) return true;
  return parseDateValue(text) !== null;
}

// ------------------------------------------------------------------ R3 ----
//
// Day/month order is proven per FORMAT PATTERN (separator + shape), never per
// column: "11-23-2025" proves the dash shape is MM-DD, which then applies to
// every ambiguous dash value in that column ("02-12-2025" → 2025-02-12),
// while "30/06/2025" proves the slash shape is DD/MM.

/** DM = day first (DD-MM), MD = month first (MM-DD). */
export type DayMonthOrder = 'DM' | 'MD';
/**
 * What to do with date patterns the file never proves:
 * 'auto' (default) keeps the original value and files a low-confidence item in
 * "Needs review"; 'DM' / 'MD' are an explicit user choice (the toggle) that
 * applies that order and says so.
 */
export type DateOrderMode = DayMonthOrder | 'auto';

/**
 * Split a trailing clock time off a date string.
 * Returns the date part and the time as `HH:mm` (24-hour, to the minute).
 * "5 Jan 2024 2:30 PM" → { datePart: '5 Jan 2024', time: '14:30' }.
 */
export function splitClock(value: string): { datePart: string; time: string } | null {
  const match = /^(.*?)[T ,]+(\d{1,2})(?::(\d{2}))?(?::\d{2}(?:\.\d+)?)?\s*([ap])\.?\s*m\.?$/i.exec(value);
  const noMeridiem = match
    ? null
    : /^(.*?)[T ,]+(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value);
  const hit = match ?? noMeridiem;
  if (!hit) return null;
  const datePart = (hit[1] as string).trim();
  if (datePart === '') return null;
  let hours = Number(hit[2]);
  const minutes = Number(hit[3] ?? '0');
  if (match) {
    const meridiem = (hit[4] as string).toLowerCase();
    if (meridiem === 'p' && hours < 12) hours += 12;
    if (meridiem === 'a' && hours === 12) hours = 0;
  }
  if (hours > 23 || minutes > 59) return null;
  // A clock is only a clock when a real date precedes it.
  if (!/\d/.test(datePart)) return null;
  return { datePart, time: `${pad(hours)}:${pad(minutes)}` };
}

/** 2025-06-01 · 2025/06/01 · 2025.06.01 – year first, never ambiguous. */
const YEAR_FIRST_RE = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/;
/** 06-01-2025 · 06/01/2025 · 06.01.25 – separator + shape, order to prove. */
const NUMERIC_RE = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{2,4})$/;
/** 17-Apr-2026 · 17 April 2026 – month is named, never ambiguous. */
const DAY_NAMED_RE = /^(\d{1,2})[- ,]([a-z]{3,9})[- ,](\d{2,4})$/i;
/** Feb 17, 2026 · Apr 17 2026 – month is named, never ambiguous. */
const NAMED_DAY_RE = /^([a-z]{3,9})[- ,](\d{1,2}),?[- ,](\d{2,4})$/i;

/** Separator + shape identity, e.g. "numeric-/-4" or "numeric--4". */
export function datePatternKey(value: string): string | null {
  const trimmed = value.trim();
  // A trailing clock does not change the day/month pattern of the date.
  const clock = splitClock(trimmed);
  const s = clock ? clock.datePart : trimmed;
  const yearFirst = YEAR_FIRST_RE.exec(s);
  if (yearFirst) return `year-first${yearFirst[2]}4`;
  const numeric = NUMERIC_RE.exec(s);
  if (numeric) return `numeric${numeric[2]}${numeric[4].length}`;
  if (DAY_NAMED_RE.test(s) || NAMED_DAY_RE.test(s)) return 'named';
  return null;
}

interface NumericSample {
  first: number;
  second: number;
}

function numericSample(value: string): NumericSample | null {
  const clock = splitClock(value.trim());
  const match = NUMERIC_RE.exec(clock ? clock.datePart : value.trim());
  if (!match) return null;
  return { first: Number(match[1]), second: Number(match[3]) };
}

/**
 * Prove the day/month order for every numeric pattern seen in these values.
 * A pattern with no proof maps to null → the caller flags `date_ambiguous`
 * and falls back to the UI toggle.
 */
export function inferDayMonthOrder(values: string[]): Map<string, DayMonthOrder | null> {
  const proofs = new Map<string, { dayFirst: number; monthFirst: number }>();
  for (const value of values) {
    const key = datePatternKey(value);
    if (key === null || key.startsWith('year-first') || key === 'named') continue;
    const sample = numericSample(value);
    if (!sample) continue;
    const entry = proofs.get(key) ?? { dayFirst: 0, monthFirst: 0 };
    if (sample.first > 12 && sample.second <= 12) entry.dayFirst += 1;
    else if (sample.second > 12 && sample.first <= 12) entry.monthFirst += 1;
    proofs.set(key, entry);
  }

  const orders = new Map<string, DayMonthOrder | null>();
  for (const [key, proof] of proofs) {
    if (proof.dayFirst > 0 && proof.monthFirst === 0) orders.set(key, 'DM');
    else if (proof.monthFirst > 0 && proof.dayFirst === 0) orders.set(key, 'MD');
    else if (proof.dayFirst > proof.monthFirst) orders.set(key, 'DM');
    else if (proof.monthFirst > proof.dayFirst) orders.set(key, 'MD');
    else orders.set(key, null);
  }
  return orders;
}

export interface DateResolution {
  /** ISO value per input index (null when the value is not a date). */
  values: (string | null)[];
  /** Indices whose day/month order was never proven → `date_ambiguous`. */
  ambiguousIndices: number[];
  /** How many values were written as ISO instead of left as-is. */
  converted: number;
}

/**
 * Parse a column of dates with the proven per-pattern order.
 *
 * Unproven patterns are the honesty boundary (principle 2): in 'auto' mode
 * the original value is KEPT and the index is reported as ambiguous so the UI
 * can offer the default reading as a suggestion; an explicit `mode` (the
 * toggle, or an accepted review item) applies that order instead.
 */
export function resolveDates(values: Cell[], mode: DateOrderMode = 'auto'): DateResolution {
  const texts = values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((text) => text !== '');
  const orders = inferDayMonthOrder(texts);

  const out: (string | null)[] = [];
  const ambiguousIndices: number[] = [];
  let converted = 0;

  values.forEach((cell, index) => {
    if (cell === null || cell === undefined || typeof cell !== 'string' || cell.trim() === '') {
      out.push(null);
      return;
    }
    const text = cell.trim();
    const key = datePatternKey(text);
    const needsProof = key !== null && !key.startsWith('year-first') && key !== 'named';

    if (needsProof) {
      const proven = orders.get(key) ?? null;
      if (proven === null) {
        // Pattern never proved – flag it, then honour the user's mode.
        ambiguousIndices.push(index);
        if (mode === 'auto') {
          out.push(text); // original kept, suggestion filed in Needs review
          return;
        }
        const iso = parseDateWithOrder(text, mode);
        out.push(iso ?? text);
        if (iso !== null) converted += 1;
        return;
      }
      const iso = parseDateWithOrder(text, proven);
      if (iso === null) {
        // Proven order but the date itself is impossible (31-02) – keep it.
        ambiguousIndices.push(index);
        out.push(text);
        return;
      }
      out.push(iso);
      converted += 1;
      return;
    }

    // Named / year-first / datetime shapes have no day/month ambiguity.
    const iso = parseDateWithOrder(text, 'DM');
    if (iso === null) {
      out.push(text); // not a date – keep it, the column demotes to text
      return;
    }
    out.push(iso);
    converted += 1;
  });

  return { values: out, ambiguousIndices, converted };
}

/** Parse one value honouring an explicit day/month order for numeric shapes. */
export function parseDateWithOrder(value: string, order: DayMonthOrder): string | null {
  const clock = splitClock(value.trim());
  if (clock) {
    const base = parseDateWithOrder(clock.datePart, order);
    return base ? `${base}T${clock.time}` : null;
  }
  const s = value.trim();
  if (!s || s.length > 40) return null;

  const yearFirst = YEAR_FIRST_RE.exec(s);
  if (yearFirst) {
    return buildDate(Number(yearFirst[1]), Number(yearFirst[3]), Number(yearFirst[4]));
  }

  const numeric = NUMERIC_RE.exec(s);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[3]);
    const year = Number(numeric[4]);
    const day = order === 'DM' ? first : second;
    const month = order === 'DM' ? second : first;
    return buildDate(year, month, day);
  }

  const dayNamed = DAY_NAMED_RE.exec(s);
  if (dayNamed && MONTHS[dayNamed[2].toLowerCase()]) {
    return buildDate(Number(dayNamed[3]), MONTHS[dayNamed[2].toLowerCase()], Number(dayNamed[1]));
  }
  const namedDay = NAMED_DAY_RE.exec(s);
  if (namedDay && MONTHS[namedDay[1].toLowerCase()]) {
    return buildDate(Number(namedDay[3]), MONTHS[namedDay[1].toLowerCase()], Number(namedDay[2]));
  }

  // Times, month-year, Excel serials … handled by the general parser.
  return parseDateValue(s);
}

/** JS Date → ISO string (date only when the time is midnight). */
export function formatJsDate(value: Date): string | null {
  if (Number.isNaN(value.getTime())) return null;
  const hasTime = value.getUTCHours() || value.getUTCMinutes() || value.getUTCSeconds();
  const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  return hasTime
    ? `${date}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
    : date;
}

/** Excel serial date (1899-12-30 epoch) → ISO date/datetime. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const hasTime = Math.abs(serial - Math.trunc(serial)) > 1e-9;
  const isoDate = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  if (!hasTime) return isoDate;
  return `${isoDate}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}
