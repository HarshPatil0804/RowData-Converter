import type { Cell } from '../types';
import { cleanText } from './strings';

const CURRENCY = /[$€£¥₹₽¢₩₪₫฿]/g;
const CURRENCY_WORD = /^(?:inr|rs|usd|eur|gbp|jpy|cny|aud|cad|chf)\.?\s*/i;

/**
 * Parse human-formatted numbers: "$1,234.50", "(999)", "45%", "1'234", "1.234,56", "12 ".
 * Returns null when the value is not numeric. Percent signs are stripped so the
 * value becomes a plain number (45% → 45), currency symbols are removed.
 */
export function parseNumberValue(value: Cell): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return null;

  let s = cleanText(String(value)).trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  s = s.replace(CURRENCY, '');
  s = s.replace(CURRENCY_WORD, '');
  if (s.endsWith('%')) s = s.slice(0, -1).trim();
  s = s.replace(/\s+/g, '');
  // Swiss/European thousands apostrophes: 1'234.5
  s = s.replace(/'(?=\d)/g, '');

  if (/^[+-]/.test(s)) {
    if (s.startsWith('-')) negative = !negative;
    s = s.slice(1);
  }

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // 1.234,56 → European
      s = s.replace(/\./g, '').replace(/,/g, '.');
    } else {
      // 1,234.56 → English
      s = s.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    const decimals = parts.length === 2 ? parts[1] : '';
    if (decimals.length === 3 && parts.length === 2 && parts[0].length <= 3) {
      s = parts.join(''); // 1,234 → thousands separator
    } else if (decimals.length === 0 && parts.length > 2) {
      s = parts.join(''); // 1,234,567
    } else if (parts.length > 2) {
      s = parts.join(''); // 1,234,567 style already handled
    } else {
      s = `${parts[0]}.${decimals}`; // 12,50 → decimal comma
    }
  }

  if (!/^\d*\.?\d+$|^\d+\.?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

/**
 * R13 – a value written out in words ("Twelve", "twenty five", "FORTY").
 * Only a value that is *nothing but* number words parses, so prose such as
 * "one more thing" never becomes a number. Returns null otherwise.
 */
export function spelledToNumber(value: string): number | null {
  const words = value
    .trim()
    .toLowerCase()
    .replace(/[-\u2013\u2014]/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter((word) => word !== '' && word !== 'and');
  if (words.length === 0 || words.length > 6) return null;

  let total = 0;
  let current = 0;
  let matched = false;
  for (const word of words) {
    if (word in NUMBER_WORDS) {
      const value = NUMBER_WORDS[word];
      // "twenty five" adds; "one two" would too – words are read as a sum of
      // tens/units, which is unambiguous for the forms R13 promises.
      current += value;
      matched = true;
    } else if (word === 'hundred') {
      if (current === 0) return null;
      current *= 100;
      matched = true;
    } else if (word === 'thousand') {
      if (current === 0) return null;
      total += current * 1000;
      current = 0;
      matched = true;
    } else {
      return null;
    }
  }
  return matched ? total + current : null;
}

/** True when the raw string looks numeric (used for type inference). */
export function looksNumeric(value: string): boolean {
  return parseNumberValue(value) !== null;
}

/** True when the raw value carried a percent sign (for quality notes). */
export function hasPercentSign(value: string): boolean {
  return cleanText(value).trim().endsWith('%');
}

/** True when the raw value carried a currency symbol or code (for quality notes). */
export function hasCurrencySign(value: string): boolean {
  return /[$€£¥₹₽¢₩₪₫฿]|\b(?:inr|rs|usd|eur|gbp|jpy|cny|aud|cad|chf)\b/i.test(value);
}
