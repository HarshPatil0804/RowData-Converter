import type { Extraction } from '../../types';
import { decodeText, type Detection } from '../detect';
import { spreadsheetToExtraction } from './spreadsheet';
import { xmlToExtraction } from './xml';
import { htmlToExtraction } from './html';
import { jsonToExtraction } from './json';
import { yamlToExtraction } from './yaml';
import { rtfToExtraction } from './rtf';
import { emlToExtraction } from './eml';
import { docxToExtraction } from './docx';
import { pdfToExtraction } from './pdf';
import { imageToExtraction } from './image';
import { parseDelimited } from './delimited';
import {
  assertColumnCount,
  assertHeuristicBudget,
  assertImagePixels,
  assertJsonDepth,
  assertLineLengths,
  assertNoDoctypeEntities,
  assertXmlDepth,
} from '../limits';

export type ProgressFn = (fraction: number, message: string) => void;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * Extract stage: pick the right parser for the detected source type. Every
 * path returns an Extraction (table | records | text) or throws a readable
 * error for corrupted / unsupported input.
 */
export async function extractSource(
  detection: Detection,
  name: string,
  bytes: Uint8Array,
  onProgress?: ProgressFn,
): Promise<Extraction> {
  const report: ProgressFn = onProgress ?? (() => undefined);
  const source = name;
  report(0.05, 'Reading file');

  switch (detection.kind) {
    case 'spreadsheet': {
      report(0.2, 'Reading workbook');
      return spreadsheetToExtraction(toArrayBuffer(bytes), source);
    }
    case 'xml': {
      const { text } = decodeText(bytes, detection.encoding);
      // Entities and deep nesting are how XML parsers are attacked.
      assertNoDoctypeEntities(text);
      assertXmlDepth(text);
      assertHeuristicBudget(text);
      return xmlToExtraction(text, source);
    }
    case 'html': {
      const { text } = decodeText(bytes, detection.encoding);
      assertHeuristicBudget(text);
      return htmlToExtraction(text, source);
    }
    case 'json': {
      const { text } = decodeText(bytes, detection.encoding);
      assertJsonDepth(text);
      assertHeuristicBudget(text);
      return jsonToExtraction(text, source);
    }
    case 'yaml':
      return yamlToExtraction(decodeText(bytes, detection.encoding).text, source);
    case 'rtf':
      return rtfToExtraction(decodeText(bytes, detection.encoding).text, source);
    case 'eml':
      return emlToExtraction(decodeText(bytes, detection.encoding).text, source);
    case 'docx':
      return docxToExtraction(bytes, source);
    case 'pdf':
      return pdfToExtraction(bytes, source, (fraction) => report(0.15 + fraction * 0.8, 'Extracting PDF text'));
    case 'image':
      assertImagePixels(bytes);
      return imageToExtraction(bytes, source, (fraction, message) =>
        report(0.1 + fraction * 0.8, message === 'ocr' ? 'Running OCR' : `OCR: ${message}`),
      );
    case 'delimited': {
      const { text } = decodeText(bytes, detection.encoding);
      // Checked before parsing: a 50 MB single line is refused in one pass
      // instead of being handed to the CSV scanner.
      assertLineLengths(text);
      const hint = detection.extension === 'tsv' || detection.extension === 'tab' ? '\t' : undefined;
      const parsed = parseDelimited(text, hint);
      if (parsed.rows.length === 0) throw new Error('File contains no rows');
      assertColumnCount(Math.max(...parsed.rows.map((row) => row.length)));
      const label = parsed.delimiter === '\t' ? 'TAB' : `"${parsed.delimiter}"`;
      return {
        kind: 'table',
        source,
        columns: [],
        rows: parsed.rows,
        strategy: `Delimited text · delimiter ${label}`,
        notes: parsed.notes,
      };
    }
    case 'text':
    default: {
      const { text } = decodeText(bytes, detection.encoding);
      if (!text.trim()) throw new Error('File contains no readable text');
      return { kind: 'text', source, text, strategy: 'Plain text', notes: [] };
    }
  }
}
