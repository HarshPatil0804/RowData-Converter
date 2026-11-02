import Papa from 'papaparse';
import type { Cell } from '../../types';

export interface DelimitedResult {
  columns: string[];
  rows: Cell[][];
  delimiter: string;
  notes: string[];
}

/** Candidate delimiters for the manual (extension-less) detection pass. */
const CANDIDATES = [',', '\t', ';', '|'];

/** Multi-character delimiters (pipe tables exported from spreadsheets/reports). */
const MULTI_DELIMITER = ' | ';

function detectMultiDelimiter(text: string): { fields: number } | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 2000);
  if (lines.length < 2) return null;
  if (!lines.some((line) => line.includes(MULTI_DELIMITER))) return null;

  const frequency = new Map<number, number>();
  for (const line of lines) {
    const count = line.split(MULTI_DELIMITER).length;
    frequency.set(count, (frequency.get(count) ?? 0) + 1);
  }
  let modal = 0;
  let modalCount = 0;
  for (const [count, times] of frequency) {
    if (count < 3) continue;
    if (times > modalCount || (times === modalCount && count > modal)) {
      modal = count;
      modalCount = times;
    }
  }
  if (modal < 3) return null;
  if (modalCount / lines.length < 0.8) return null;
  return { fields: modal };
}

/**
 * Score how consistently a delimiter splits text into the same number of fields.
 * Returns null when the text does not look delimited.
 */
export function detectDelimiter(text: string): { delimiter: string; fields: number } | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 200);
  if (lines.length < 2) return null;

  let best: { delimiter: string; fields: number; score: number } | null = null;
  for (const delimiter of CANDIDATES) {
    const counts = lines.map((line) => splitLine(line, delimiter).length);
    const frequency = new Map<number, number>();
    for (const count of counts) frequency.set(count, (frequency.get(count) ?? 0) + 1);
    let modal = 2;
    let modalCount = 0;
    for (const [count, times] of frequency) {
      if (count > 1 && (times > modalCount || (times === modalCount && count > modal))) {
        modal = count;
        modalCount = times;
      }
    }
    if (modal < 2) continue;
    const score = modalCount / lines.length;
    const coverage = counts.filter((count) => count === modal).length / lines.length;
    if (coverage < 0.6) continue;
    const total = score + (modal >= 3 ? 0.15 : 0);
    if (!best || total > best.score) best = { delimiter, fields: modal, score: total };
  }
  return best ? { delimiter: best.delimiter, fields: best.fields } : null;
}

/** Split one line honouring double quotes (RFC-4180-ish). */
export function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/** Parse delimited text with Papa Parse (auto delimiter when omitted). */
export function parseDelimited(text: string, delimiter?: string): DelimitedResult {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  const notes: string[] = [];

  // "A | B | C" pipe tables need a multi-character split; Papa only handles
  // single characters, so those rows are split manually (quotes are content).
  // Every line is kept: title, export-date, error and summary lines are
  // classified into the Rejected rows table by R1 rather than dropped here.
  if (!delimiter) {
    const multi = detectMultiDelimiter(source);
    if (multi) {
      // Keep every line, blank ones included: R1 classifies them into the
      // Rejected rows table instead of this parser deleting them silently.
      const lines = source.split('\n');
      const rows: Cell[][] = [];
      for (const line of lines) {
        const cells = line
          .split(MULTI_DELIMITER)
          .map((cell) => cell.trim().replace(/^"|"$/g, '').trim());
        rows.push(cells);
      }
      notes.push(`multi-character delimiter " | " detected (${multi.fields} columns)`);
      return { columns: [], rows, delimiter: '|', notes };
    }
  }

  // Blank lines must survive parsing: R1 classifies them into the Rejected
  // rows table with a reason. Skipping them here would delete data silently.
  const parsed = Papa.parse<string[]>(source, {
    delimiter: delimiter ?? detectDelimiter(source)?.delimiter ?? '',
    skipEmptyLines: false,
    worker: false,
  });

  const rows = (parsed.data ?? [])
    .filter((row) => Array.isArray(row))
    .map((row) => row.map((cell) => (typeof cell === 'string' ? cell : String(cell))) as Cell[]);

  if (parsed.errors?.length) {
    const first = parsed.errors[0];
    notes.push(`CSV parser reported ${parsed.errors.length} issue(s); first: ${first.message} (row ${first.row ?? 0})`);
  }
  const used = parsed.meta?.delimiter || delimiter || ',';
  notes.push(`delimiter detected: ${used === '\t' ? 'TAB' : `"${used}"`}`);

  return {
    columns: [],
    rows,
    delimiter: used,
    notes,
  };
}
