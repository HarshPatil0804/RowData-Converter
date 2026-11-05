import { createWorker } from 'tesseract.js';
import { simd } from 'wasm-feature-detect';
import type { Extraction } from '../../types';
import { isNodeRuntime } from '../../lib/env';
import { reconstructTable, gridFromWhitespace, gridLooksTabular, type PositionedLine } from '../../lib/columns';

type ProgressFn = (fraction: number, message: string) => void;

interface TesseractWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
interface TesseractLine {
  words?: TesseractWord[] | null;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}
interface TesseractParagraph {
  lines?: TesseractLine[] | null;
}
interface TesseractBlock {
  paragraphs?: TesseractParagraph[] | null;
}
interface RecognizePage {
  text?: string;
  blocks?: TesseractBlock[] | null;
}

function runtimeMode(): 'browser' | 'node' {
  // Node (Vitest) must win even when jsdom defines `document`: Node's worker
  // threads cannot load the http:// origin paths the browser branch builds.
  if (isNodeRuntime()) return 'node';
  if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') return 'browser';
  if (typeof document === 'object' && document !== null) return 'browser';
  return 'node';
}

async function buildWorkerOptions(onProgress: ProgressFn) {
  const logger = (message: { status?: string; progress?: number }) => {
    const pct = typeof message.progress === 'number' ? Math.max(0, Math.min(1, message.progress)) : 0;
    onProgress(pct, message.status ?? 'ocr');
  };

  if (runtimeMode() === 'node') {
    const base = process.cwd().replace(/\\/g, '/');
    return {
      logger,
      langPath: `${base}/public/tessdata`,
      workerPath: `${base}/node_modules/tesseract.js/src/worker-script/node/index.js`,
      gzip: true,
      cacheMethod: 'none',

    } as Record<string, unknown>;
  }

  const origin = typeof location !== 'undefined' ? location.origin : '';
  const simdOk = await simd().catch(() => false);
  const coreFile = simdOk ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
  return {
    logger,
    workerPath: `${origin}/tess/worker.min.js`,
    corePath: `${origin}/tess/${coreFile}`,
    langPath: `${origin}/tessdata`,
    gzip: true,
    cacheMethod: 'none',
    // tesseract.js normally fetches the worker script and re-wraps it in a
    // blob: URL. The same-origin, service-worker-cached workerPath is just as
    // good and needs no blob, so keep the plain path.
    workerBlobURL: false,
  } as Record<string, unknown>;
}

function blocksToLines(page: RecognizePage): PositionedLine[] {
  const lines: PositionedLine[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block?.paragraphs ?? []) {
      for (const line of paragraph?.lines ?? []) {
        const words = (line.words ?? []).map((word) => ({
          text: word.text,
          x0: word.bbox.x0,
          x1: word.bbox.x1,
          y0: word.bbox.y0,
          y1: word.bbox.y1,
        }));
        if (words.length > 0) {
          lines.push({ y: line.bbox?.y0 ?? words[0].y0, words });
        }
      }
    }
  }
  return lines;
}

/**
 * OCR an image with Tesseract (WASM), then reconstruct a table from the word
 * geometry. Falls back to a whitespace grid, then to free text.
 */
export async function imageToExtraction(
  bytes: Uint8Array,
  source: string,
  onProgress?: ProgressFn,
): Promise<Extraction> {
  const report = onProgress ?? (() => undefined);
  const options = await buildWorkerOptions(report);
  const worker = await createWorker('eng', 1, options as never);

  try {
    report(0.05, 'starting OCR');
    // tesseract.js accepts raw bytes at runtime; its DOM-oriented ImageLike
    // type simply does not mention it.
    const result = await worker.recognize(bytes.slice() as never, {}, { text: true, blocks: true });
    const page = result.data as unknown as RecognizePage;
    report(1, 'OCR complete');

    const notes: string[] = [];
    const lines = blocksToLines(page);
    const fullText = (page.text ?? '').trim();

    const table = lines.length >= 2 ? reconstructTable(lines) : null;
    if (table && table.length >= 2) {
      const width = Math.max(...table.map((row) => row.length));
      const rows: (string | null)[][] = table.map((row) => {
        const out: (string | null)[] = row.slice(0, width);
        while (out.length < width) out.push(null);
        return out;
      });
      const header = rows[0];
      const body = rows.slice(1);
      const headerTextual =
        header.filter((cell) => cell !== null && cell !== '').length > 0 &&
        header.every((cell) => cell === null || Number.isNaN(Number(cell)));
      const hasHeader = headerTextual && body.length > 0;
      const columns = hasHeader
        ? header.map((cell, index) => (cell === null || cell === '' ? `col_${index + 1}` : cell))
        : header.map((_, index) => `col_${index + 1}`);
      notes.push('word geometry produced a column grid');
      return {
        kind: 'table',
        source,
        columns,
        rows: hasHeader ? body : rows,
        hasHeader,
        strategy: 'OCR table (Tesseract)',
        notes,
      };
    }

    if (fullText) {
      const grid = gridFromWhitespace(fullText);
      if (gridLooksTabular(grid)) {
        const width = Math.max(...grid.map((row) => row.length));
        const rows: string[][] = grid.map((row) => {
          const out = row.slice(0, width);
          while (out.length < width) out.push('');
          return out;
        });
        const header = rows[0];
        const body = rows.slice(1);
        const hasHeader = body.length > 0 && header.every((cell) => cell === '' || Number.isNaN(Number(cell)));
        notes.push('OCR whitespace grid produced a table');
        return {
          kind: 'table',
          source,
          columns: hasHeader ? header : header.map((_, index) => `col_${index + 1}`),
          rows: hasHeader ? body : rows,
          hasHeader,
          strategy: 'OCR table (whitespace grid)',
          notes,
        };
      }
      notes.push('OCR produced plain text');
      return { kind: 'text', source, text: fullText, strategy: 'OCR text (Tesseract)', notes };
    }

    throw new Error('OCR found no text in the image');
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}
