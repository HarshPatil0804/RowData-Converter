/**
 * Line splitting for delimited text, shared by every reader so a CSV, a TSV and
 * a pipe export are tokenised by exactly the same rules.
 *
 * Quoting is RFC-4180-ish: a doubled quote inside a quoted cell is one literal
 * quote, a delimiter inside quotes is content, and a newline inside quotes does
 * not end the line.
 */

/** Split one line honouring double quotes; every cell is trimmed. */
export function splitCells(line: string, delimiter: string): string[] {
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

/**
 * Split text into logical lines: `\r` is dropped and a `\n` inside a quoted
 * cell belongs to the cell, not to the record structure. A trailing newline
 * produces no extra empty line.
 */
export function logicalLines(text: string): string[] {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '""';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === '\r' && !inQuotes) continue;
    if (char === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') lines.push(current);
  return lines;
}

/** Same normalisation the extractors apply before reading a text file. */
export function normaliseText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
}
