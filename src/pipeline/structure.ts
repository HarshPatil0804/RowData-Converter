import type { Cell, Extraction, RawTable } from '../types';
import { recordsToMatrix } from '../lib/flatten';
import { selectEntityColumns } from '../lib/entities';
import { detectDelimiter, parseDelimited } from './extract/delimited';

/**
 * Structure stage: turn an Extraction into a RawTable.
 * Text sources walk a ladder of strategies until one produces plausible rows:
 * markdown tables → log lines → repeated key:value pairs → key:value blocks →
 * delimited text → repeated line patterns → free text with entity columns.
 */

export function structureExtraction(extraction: Extraction): RawTable {
  if (extraction.kind === 'table') {
    return {
      columns: extraction.columns,
      rows: extraction.rows,
      hasHeader: extraction.hasHeader ?? null,
      strategy: extraction.strategy,
      notes: [...extraction.notes],
      rejectedRows: extraction.rejectedRows ? [...extraction.rejectedRows] : undefined,
    };
  }
  if (extraction.kind === 'records') {
    const { columns, rows } = recordsToMatrix(extraction.records);
    return {
      columns,
      rows,
      hasHeader: true,
      strategy: extraction.strategy,
      notes: [...extraction.notes],
    };
  }
  return structureText(extraction.text, extraction.strategy, extraction.notes);
}

// ---------------------------------------------------------------- markdown --

function tryMarkdownTable(text: string): RawTable | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|') && line.length > 2);
  if (lines.length < 3) return null;

  const rows = lines.map((line) =>
    line
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim()),
  );
  const isSeparator = (cells: string[]) =>
    cells.filter((cell) => /^:?-{1,}:?$/.test(cell)).length >= Math.max(1, Math.ceil(cells.length * 0.6));
  if (!isSeparator(rows[1])) return null;

  const header = rows[0];
  const body = rows.slice(2).filter((row) => row.some((cell) => cell !== ''));
  if (body.length < 1) return null;

  return {
    columns: header,
    rows: body.map((row) => row as Cell[]),
    hasHeader: true,
    strategy: 'Markdown table',
    notes: ['pipe table detected in Markdown text'],
  };
}

// -------------------------------------------------------------------- logs --

const LEVELS = 'debug|info|notice|warn|warning|error|err|critical|fatal|trace';

function parseLogLine(line: string): { timestamp: string | null; level: string | null; message: string } | null {
  // [2024-05-01 12:00:01] LEVEL message  |  2024-05-01T12:00:01Z - LEVEL - message
  const bracketTs = /^\[([^\]]{8,35})\]\s*(?:[-|]\s*)?(?:\[([A-Za-z]{3,8})\]\s*)?(.*)$/.exec(line);
  const bareTs = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*(?:[-|]\s*)?(.*)$/.exec(line);

  let timestamp: string | null = null;
  let rest = '';
  if (bracketTs && /^\d{4}-\d{2}-\d{2}/.test(bracketTs[1])) {
    timestamp = bracketTs[1];
    rest = bracketTs[2] ? `${bracketTs[2]} ${bracketTs[3] ?? ''}` : (bracketTs[3] ?? '');
  } else if (bareTs) {
    timestamp = bareTs[1];
    rest = bareTs[2] ?? '';
  } else {
    return null;
  }

  const levelMatch = new RegExp(`^(?:\\[?([A-Za-z]{3,8})\\]?\\s+[-|]?\\s*)(.*)$`, 'i').exec(rest);
  let level: string | null = null;
  let message = rest;
  if (levelMatch && new RegExp(`^(${LEVELS})$`, 'i').test(levelMatch[1])) {
    level = levelMatch[1].toUpperCase();
    message = levelMatch[2] ?? '';
  } else {
    // LEVEL directly after the timestamp: "… INFO message"
    const direct = /^\[?([A-Za-z]{3,8})\]?\s+(.*)$/.exec(rest);
    if (direct && new RegExp(`^(${LEVELS})$`, 'i').test(direct[1])) {
      level = direct[1].toUpperCase();
      message = direct[2] ?? '';
    }
  }
  return { timestamp, level, message: message.trim() };
}

function tryLogLines(lines: string[]): RawTable | null {
  if (lines.length < 3) return null;
  const parsed = lines.map((line) => parseLogLine(line));
  const matched = parsed.filter((entry) => entry !== null).length;
  if (matched / lines.length < 0.6) return null;

  const timestamps = parsed.filter((entry) => entry?.timestamp).length;
  const levels = parsed.filter((entry) => entry?.level).length;
  const withTimestamp = timestamps >= lines.length * 0.5;
  const withLevel = levels >= lines.length * 0.3;

  const columns: string[] = [];
  if (withTimestamp) columns.push('timestamp');
  if (withLevel) columns.push('level');
  columns.push('message');

  const rows: Cell[][] = lines.map((_line, index) => {
    const entry = parsed[index];
    const row: Cell[] = [];
    if (withTimestamp) row.push(entry?.timestamp ?? null);
    if (withLevel) row.push(entry?.level ?? null);
    row.push(entry?.message ?? _line);
    return row;
  });

  return {
    columns,
    rows,
    hasHeader: false,
    strategy: 'Log lines',
    notes: [`columns inferred from log structure (${matched}/${lines.length} lines matched the timestamp pattern)`],
  };
}

// -------------------------------------------------------------- key:value --

const PAIR_RE = /([A-Za-z][A-Za-z0-9 _.-]{0,40}?)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/g;
const KV_LINE_RE = /^\s*([A-Za-z][A-Za-z0-9_.-]{0,40})\s*[:=]\s*(.*)$/;
const COMMENT_RE = /^\s*(#|;|\/\/)/;

function extractPairs(line: string): [string, string][] {
  const pairs: [string, string][] = [];
  PAIR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PAIR_RE.exec(line)) !== null) {
    pairs.push([match[1].trim(), match[2].replace(/^["']|["']$/g, '')]);
  }
  return pairs;
}

function tryInlinePairs(lines: string[]): RawTable | null {
  if (lines.length < 3) return null;
  const perLine = lines.map((line) => extractPairs(line));
  const strong = perLine.filter((pairs) => pairs.length >= 2).length;
  if (strong / lines.length < 0.6) return null;

  const records = perLine
    .filter((pairs) => pairs.length >= 2)
    .map((pairs) => Object.fromEntries(pairs) as Record<string, Cell>);
  if (records.length < 2) return null;
  const { columns, rows } = recordsToMatrix(records);
  return {
    columns,
    rows,
    hasHeader: true,
    strategy: 'Repeated key:value pairs',
    notes: ['each line carried multiple key=value pairs'],
  };
}

function tryKeyValue(text: string): RawTable | null {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.split(/\r?\n/).filter((line) => line.trim() !== ''));
  const kvBlocks = blocks.filter(
    (block) => block.length >= 2 && block.every((line) => COMMENT_RE.test(line) || KV_LINE_RE.test(line)),
  );

  if (kvBlocks.length >= 2) {
    const records = kvBlocks.map((block) => {
      const record: Record<string, Cell> = {};
      for (const line of block) {
        if (COMMENT_RE.test(line)) continue;
        const match = KV_LINE_RE.exec(line);
        if (match) record[match[1].trim()] = match[2].trim();
      }
      return record;
    });
    const { columns, rows } = recordsToMatrix(records);
    return {
      columns,
      rows,
      hasHeader: true,
      strategy: 'key:value blocks',
      notes: [`${kvBlocks.length} blocks of key:value pairs`],
    };
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const content = lines.filter((line) => !COMMENT_RE.test(line));
  if (content.length >= 2 && content.every((line) => KV_LINE_RE.test(line))) {
    const entries = content.map((line) => {
      const match = KV_LINE_RE.exec(line);
      return match ? [match[1].trim(), match[2].trim()] : null;
    }).filter((entry): entry is [string, string] => entry !== null);

    const keys = entries.map(([key]) => key);
    const uniqueKeys = new Set(keys).size === keys.length;

    if (uniqueKeys) {
      const record: Record<string, Cell> = Object.fromEntries(entries);
      const { columns, rows } = recordsToMatrix([record]);
      return {
        columns,
        rows,
        hasHeader: true,
        strategy: 'key:value pairs',
        notes: ['single key:value block flattened into one row'],
      };
    }

    const records = entries.map(([key, value]) => ({ key, value }));
    const { columns, rows } = recordsToMatrix(records);
    return {
      columns,
      rows,
      hasHeader: true,
      strategy: 'key:value pairs',
      notes: ['repeated keys turned into long-format key/value rows'],
    };
  }

  return null;
}

// -------------------------------------------------------------- delimited --
// ------------------------------------------------------- repeated patterns --

function templateOf(line: string): string {
  return line
    .replace(/\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?/g, '#')
    .replace(/\d+/g, '#')
    .replace(/[A-Za-z]+/g, 'A')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLike(sample: string[], line: string): string[] | null {
  // 1. Aligned columns (2+ spaces) win: thousands commas stay intact.
  const multi = (text: string) => text.split(/\s{2,}/).map((cell) => cell.trim()).filter((cell) => cell !== '');
  const sampleMulti = sample.map(multi);
  const width = sampleMulti[0]?.length ?? 0;
  if (width >= 2 && sampleMulti.every((cells) => cells.length === width)) {
    const mine = multi(line);
    if (mine.length === width) return mine;
  }

  // 2. A real delimiter shared by every sample line.
  const delimited = detectDelimiter(sample.join('\n'));
  if (delimited && delimited.fields >= 2) {
    const parsed = parseDelimited(line, delimited.delimiter);
    const row = parsed.rows[0] as string[] | undefined;
    if (row) return row;
  }

  // 3. Uniform single-space token count.
  const ws = line.split(/\s+/);
  if (ws.length >= 2 && sample.every((entry) => entry.split(/\s+/).length === ws.length)) return ws;
  return null;
}

function tryPatternedLines(lines: string[]): RawTable | null {
  if (lines.length < 3) return null;

  const templates = lines.map(templateOf);
  let best = { start: -1, end: -1, template: '' };
  let runStart = 0;
  for (let index = 1; index <= templates.length; index += 1) {
    if (index < templates.length && templates[index] === templates[runStart]) continue;
    const length = index - runStart;
    const template = templates[runStart];
    const numbers = (template.match(/#/g) ?? []).length;
    const separators = (template.match(/[^\w\s]/g) ?? []).length;
    if (length >= 3 && numbers >= 2 && separators >= 1 && length > best.end - best.start) {
      best = { start: runStart, end: index, template };
    }
    runStart = index;
  }
  if (best.start === -1) return null;

  const runLines = lines.slice(best.start, best.end);
  const cells = runLines.map((line) => splitLike(runLines, line));
  if (cells.some((row) => !row || row.length < 2)) return null;

  const width = (cells[0] as string[]).length;
  if (!cells.every((row) => (row as string[]).length === width)) return null;

  // A line of pure alpha labels right above the run acts as the header.
  let header: string[] | null = null;
  if (best.start > 0) {
    const candidate = lines[best.start - 1];
    const parts = splitLike(runLines, candidate);
    if (
      parts &&
      parts.length === width &&
      parts.every((part) => /^[A-Za-z][A-Za-z0-9 ._/&()#%-]*$/.test(part))
    ) {
      header = parts;
    }
  }

  const rows = cells as string[][];
  return {
    columns: header ?? [],
    rows: rows.map((row) => row as Cell[]),
    hasHeader: header ? true : false,
    strategy: 'Repeated line pattern',
    notes: [`${rows.length} lines share one structural template`],
  };
}

// ------------------------------------------------------------ free text ----

function tryFreeText(text: string): RawTable {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph !== '');
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  let rows: string[];
  let label: string;
  if (paragraphs.length >= 3) {
    rows = paragraphs;
    label = 'paragraphs';
  } else if (lines.length >= 4) {
    rows = lines;
    label = 'lines';
  } else {
    rows = [text.replace(/\s+/g, ' ').trim()];
    label = 'text';
  }

  const entityColumns = selectEntityColumns(rows);
  const columns = ['text', ...entityColumns.keys()];
  const matrix: Cell[][] = rows.map((row) => {
    const values: Cell[] = [row];
    for (const extract of entityColumns.values()) values.push(extract(row));
    return values;
  });

  const notes: string[] = [`split into ${rows.length} record(s) by ${label}`];
  if (entityColumns.size > 0) {
    notes.push(`regex entities extracted: ${[...entityColumns.keys()].join(', ')}`);
  }

  return {
    columns,
    rows: matrix,
    hasHeader: false,
    strategy: 'Free text records',
    notes,
  };
}

// ---------------------------------------------------------------- dispatch --

function structureText(text: string, strategy: string, notes: string[]): RawTable {
  if (!text.trim()) {
    throw new Error('No text content could be extracted from this file');
  }
  const shared = [...notes];

  const markdown = tryMarkdownTable(text);
  if (markdown) return { ...markdown, notes: [...shared, ...markdown.notes] };

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length >= 3) {
    const logs = tryLogLines(lines);
    if (logs) return { ...logs, notes: [...shared, ...logs.notes] };

    const pairs = tryInlinePairs(lines);
    if (pairs) return { ...pairs, notes: [...shared, ...pairs.notes] };
  }

  const keyValue = tryKeyValue(text);
  if (keyValue) return { ...keyValue, notes: [...shared, ...keyValue.notes] };

  const patterned = tryPatternedLines(lines);
  if (patterned) return { ...patterned, notes: [...shared, ...patterned.notes] };

  const free = tryFreeText(text);
  return { ...free, strategy, notes: [...shared, ...free.notes] };
}
