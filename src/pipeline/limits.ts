/**
 * Documented input limits.
 *
 * Everything here exists because a browser tab is a shared resource: a hostile
 * or simply awful file must be refused with a readable message before it can
 * freeze the page. The same numbers are published in the README ("Limits").
 *
 * Each guard throws an Error whose message is shown to the user verbatim, so
 * the text is written for a person, not a log.
 */
export const LIMITS = {
  /** Bytes of the file itself (one upload). */
  inputBytes: 200 * 1024 * 1024,
  /** Uncompressed bytes read out of one archive (all members together). */
  archiveUncompressedBytes: 300 * 1024 * 1024,
  /** Refuse an archive that expands more than this: classic zip-bomb shape. */
  archiveCompressionRatio: 200,
  /** Files inside one archive. */
  archiveEntries: 2000,
  /** Archives inside archives (zip in zip in zip). */
  archiveDepth: 3,
  /** Nesting depth of JSON/XML/object documents. */
  nestingDepth: 256,
  /** Longest single line we will parse (a 50 MB line is not a table). */
  lineBytes: 2 * 1024 * 1024,
  /** Columns in one table. */
  columns: 4096,
  /** Rows in one table. */
  rows: 2_000_000,
  /** Decoded pixels before OCR (40 MP ≈ 8000×5000). */
  imagePixels: 40_000_000,
  /** Characters handed to regex-based heuristics in one call. */
  heuristicChars: 2 * 1024 * 1024,
} as const;

const mb = (bytes: number): string => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

/** A limit was hit; `message` is user-facing and explains what to do. */
export class LimitError extends Error {
  readonly limit: string;

  constructor(limit: string, message: string) {
    super(message);
    this.name = 'LimitError';
    this.limit = limit;
  }
}

/**
 * Longest line check. A delimited file with a single enormous line is either a
 * binary blob mislabelled .csv or an attack on the parser; either way it is
 * refused before parsing, and the scan stops at the first offender.
 */
export function assertLineLengths(text: string): void {
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    const length = end - start;
    if (length > LIMITS.lineBytes) {
      throw new LimitError(
        'line',
        `One line in this file is ${mb(length)}, but the limit is ${mb(LIMITS.lineBytes)} per line. ` +
          'Add line breaks (one record per line) and try again.',
      );
    }
    if (newline === -1) break;
    start = newline + 1;
  }
}

/** Refuse tables wider than the documented column limit. */
export function assertColumnCount(count: number): void {
  if (count > LIMITS.columns) {
    throw new LimitError(
      'columns',
      `This table has ${count.toLocaleString()} columns, but the limit is ${LIMITS.columns.toLocaleString()}. ` +
        'Delete the columns you do not need and try again.',
    );
  }
}

/** Refuse tables with more rows than the documented limit. */
export function assertRowCount(count: number): void {
  if (count > LIMITS.rows) {
    throw new LimitError(
      'rows',
      `This table has ${count.toLocaleString()} rows, but the limit is ${LIMITS.rows.toLocaleString()}. ` +
        'Split the file and try again.',
    );
  }
}

/**
 * Maximum bracket depth of a JSON-like document. String literals are skipped,
 * so `"[["` does not count as nesting. Runs in one pass with no recursion, so
 * it cannot itself overflow on a pathological document.
 */
export function maxJsonDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth > max) max = depth;
    } else if (ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1);
    }
  }
  // The full scan is one O(n) pass and lets the message state the real depth
  // instead of "at least 257".
  return max;
}

export function assertJsonDepth(text: string): void {
  const depth = maxJsonDepth(text);
  if (depth > LIMITS.nestingDepth) {
    throw new LimitError(
      'nesting',
      `This document is nested ${depth.toLocaleString()} levels deep, but the limit is ` +
        `${LIMITS.nestingDepth}. Export it flattened and try again.`,
    );
  }
}

/**
 * XML depth, counted from opening tags. Comments, CDATA and declarations are
 * skipped so only real element nesting is measured.
 */
export function maxXmlDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('<', i);
    if (open === -1) break;
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    const close = text.indexOf('>', open);
    if (close === -1) break;
    const tag = text.slice(open + 1, close).trim();
    i = close + 1;
    if (tag === '' || tag.startsWith('?') || tag.startsWith('!')) continue;
    const selfClosing = tag.endsWith('/');
    if (tag.startsWith('/')) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (selfClosing) continue;
    depth += 1;
    if (depth > max) max = depth;
  }
  return max;
}

export function assertXmlDepth(text: string): void {
  const depth = maxXmlDepth(text);
  if (depth > LIMITS.nestingDepth) {
    throw new LimitError(
      'nesting',
      `This document is nested ${depth.toLocaleString()} element levels deep, but the limit is ` +
        `${LIMITS.nestingDepth}. Export it flattened and try again.`,
    );
  }
}

/**
 * External-entity declarations ("billion laughs", XXE) have no place in a file
 * this app can read: every value is already local, and resolving entities is
 * how a parser is made to expand 1 KB into gigabytes or to read a file path.
 */
const DOCTYPE_ENTITY = /<!DOCTYPE[^>[]*\[|<!(?:ENTITY|ELEMENT|ATTLIST)\b/i;

export function assertNoDoctypeEntities(text: string): void {
  if (DOCTYPE_ENTITY.test(text)) {
    throw new LimitError(
      'entities',
      'This document declares a DOCTYPE or XML entities. Entity expansion is disabled, because it is ' +
        'used to blow up parsers and to reach outside the file. Re-export it without the DOCTYPE.',
    );
  }
}

/** Guard for the regex-driven heuristics: refuse obviously oversized input. */
export function assertHeuristicBudget(text: string): void {
  if (text.length > LIMITS.heuristicChars) {
    throw new LimitError(
      'size',
      `This file holds ${mb(text.length)} of text, but the limit for a single document is ` +
        `${mb(LIMITS.heuristicChars)}. Split it and try again.`,
    );
  }
}

// ------------------------------------------------------------- images ----

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * Pixel dimensions from the file header alone, so a decompression bomb never
 * reaches the decoder or the OCR engine.
 */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: 89 50 4E 47 ... IHDR width/height at 16..24
  if (
    bytes.length > 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // GIF: "GIF87a"/"GIF89a", little-endian 16-bit at 6..10
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  // WebP (VP8X / VP8 / VP8L)
  if (
    bytes.length > 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === 'VP8X') {
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    }
    if (chunk === 'VP8L') {
      const bits = view.getUint32(21, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ') {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
  }
  // JPEG: walk the marker segments to a start-of-frame.
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      const length = (bytes[i + 2] << 8) | bytes[i + 3];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return {
          height: (bytes[i + 5] << 8) | bytes[i + 6],
          width: (bytes[i + 7] << 8) | bytes[i + 8],
        };
      }
      i += 2 + Math.max(2, length);
    }
  }
  return null;
}

export function assertImagePixels(bytes: Uint8Array): void {
  const size = imageSize(bytes);
  if (!size) return;
  const pixels = size.width * size.height;
  if (pixels > LIMITS.imagePixels) {
    throw new LimitError(
      'image',
      `This image is ${size.width.toLocaleString()}×${size.height.toLocaleString()} ` +
        `(${Math.round(pixels / 1_000_000)} megapixels), but the limit is ` +
        `${LIMITS.imagePixels / 1_000_000} megapixels. Downscale it and try again.`,
    );
  }
}
