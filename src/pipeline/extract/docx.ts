import * as mammoth from 'mammoth';
import type { Extraction } from '../../types';
import { htmlToExtraction } from './html';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * DOCX reader: mammoth converts to semantic HTML, then the HTML reader picks
 * up tables (or falls back to paragraph text).
 */
export async function docxToExtraction(bytes: Uint8Array, source: string): Promise<Extraction> {
  let html: string;
  try {
    // mammoth ships two unzip implementations: the browser build that Vite
    // bundles into the worker reads `arrayBuffer`, the Node build used by the
    // tests reads `buffer`. Supplying both keeps a single call site working in
    // both, instead of failing in the browser with "Could not find file in
    // options".
    const arrayBuffer = toArrayBuffer(bytes);
    type MammothInput = Parameters<typeof mammoth.convertToHtml>[0];
    const input = { buffer: arrayBuffer, arrayBuffer } as unknown as MammothInput;
    const result = await mammoth.convertToHtml(input);
    html = result.value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read DOCX file: ${message}`);
  }

  const extraction = htmlToExtraction(html, source);
  if (extraction.strategy === 'HTML table') {
    return { ...extraction, strategy: 'Word table', notes: [...extraction.notes, 'tables converted by mammoth'] };
  }
  return { ...extraction, strategy: 'DOCX document', notes: [...extraction.notes, 'text converted by mammoth'] };
}
