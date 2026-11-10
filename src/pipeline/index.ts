import type { Dataset, ProgressUpdate, ReviewItem } from '../types';
import type { DateOrderMode } from '../lib/dates';
import type { Tuning } from './typing';
import { detectSource, type SourceKind } from './detect';
import { extractSource } from './extract/index';
import { extractArchive } from './extract/archive';
import { structureExtraction } from './structure';
import { cleanTable } from './clean';
import { splitTables, type SplitTable } from './tables';
import { LIMITS, assertColumnCount, assertRowCount } from './limits';

export interface ProcessOptions {
  onProgress?: (update: ProgressUpdate) => void;
  /** Nesting depth for archives inside archives. */
  depth?: number;
  /**
   * R3 – how to read date patterns the file never proves. 'auto' (default)
   * keeps the original values and files review suggestions; 'DM'/'MD' is the
   * explicit UI toggle and applies that order.
   */
  dateOrder?: DateOrderMode;
  /** Review items the user accepted – their suggestion is applied on re-run. */
  acceptReviews?: readonly string[];
  /** Typing thresholds; used by the fuzz harness to sweep four values each. */
  tuning?: Partial<Tuning>;
}

const MAX_ARCHIVE_DEPTH = LIMITS.archiveDepth;

function mimeFor(name: string): string {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const map: Record<string, string> = {
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    zip: 'application/zip',
  };
  return map[extension] ?? 'application/octet-stream';
}

/**
 * The whole automated pipeline for one file: detect → extract → structure →
 * clean → report. Archives recurse and yield one Dataset per inner file.
 */
export async function processBytes(
  name: string,
  mime: string,
  bytes: Uint8Array | ArrayBuffer,
  options: ProcessOptions = {},
): Promise<Dataset[]> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const emit = options.onProgress ?? (() => undefined);
  const depth = options.depth ?? 0;

  if (data.byteLength > LIMITS.inputBytes) {
    throw new Error(
      `This file is ${(data.byteLength / (1024 * 1024)).toFixed(1)} MB, but the limit is ` +
        `${LIMITS.inputBytes / (1024 * 1024)} MB. Split it and try again — nothing was uploaded.`,
    );
  }

  emit({ pct: 3, stage: 'detect', message: `Detecting file type of ${name}` });
  const detection = detectSource(name, mime, data);
  const label = `${detection.kind} · ${detection.reason}`;

  if (detection.kind === 'zip') {
    if (depth >= MAX_ARCHIVE_DEPTH) {
      throw new Error(
        `Archives nested more than ${MAX_ARCHIVE_DEPTH} levels deep are not opened. ` +
          'Extract the innermost archive yourself and drop that instead.',
      );
    }
    emit({ pct: 8, stage: 'extract', message: 'Opening ZIP archive' });
    const entries = await extractArchive(data);
    if (entries.length === 0) {
      throw new Error('ZIP archive is empty or contains no readable files');
    }
    const datasets: Dataset[] = [];
    const skipped: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const base = 10 + (index / entries.length) * 75;
      emit({
        pct: base,
        stage: 'extract',
        message: `Archive member ${index + 1}/${entries.length}: ${entry.name}`,
      });
      try {
        const inner = await processBytes(entry.name, mimeFor(entry.name), entry.bytes, {
          depth: depth + 1,
          dateOrder: options.dateOrder,
          acceptReviews: options.acceptReviews,
          onProgress: (update) =>
            emit({
              pct: base + (update.pct / 100) * (75 / entries.length),
              stage: update.stage,
              message: `${entry.name}: ${update.message}`,
            }),
        });
        datasets.push(...inner);
      } catch (error) {
        skipped.push(`${entry.name} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    if (datasets.length === 0) {
      throw new Error(`No processable files in archive. Skipped: ${skipped.join('; ')}`);
    }
    if (skipped.length > 0 && datasets[0]) {
      datasets[0].report.notes.push(`archive entries skipped: ${skipped.join('; ')}`);
    }
    emit({ pct: 100, stage: 'done', message: 'Archive processed' });
    return datasets;
  }

  emit({ pct: 8, stage: 'extract', message: `Extracting content (${label})` });
  const extraction = await extractSource(detection, name, data, (fraction, message) => {
    emit({
      pct: 8 + Math.max(0, Math.min(1, fraction)) * 34,
      stage: 'extract',
      message: message || 'Extracting content',
    });
  });

  emit({ pct: 48, stage: 'structure', message: 'Building rows and columns' });
  const raw = structureExtraction(extraction);
  // Width and height are checked after structuring, because flattening nested
  // JSON is what turns three keys into a million columns.
  assertColumnCount(raw.columns.length);
  assertRowCount(raw.rows.length);

  emit({ pct: 62, stage: 'clean', message: 'Cleaning and typing values' });

  // S2 – a file can hold more than one table. Each block is cleaned on its own
  // and becomes its own dataset (the table picker switches between them), so no
  // row is ever placed under columns it does not belong to.
  const splits = splitTables(raw);
  const datasets = splits.map((split) => {
    const label = splits.length > 1 ? `${name} · table ${split.index} of ${splits.length}` : name;
    return cleanTable(split.table, label, detection.kind as SourceKind, {
      dateOrder: options.dateOrder,
      acceptReviews: options.acceptReviews,
      tuning: options.tuning,
    });
  });

  // S2 – the split is applied (each block is its own dataset, switchable in the
  // picker) but it is still a judgement call about the file, so it is filed for
  // review with the source rows it came from.
  if (splits.length > 1) {
    for (const dataset of datasets) {
      const split = splits[datasets.indexOf(dataset)] as SplitTable;
      const item: ReviewItem = {
        id: `table_split:${dataset.report.fileName}:${split.index}`,
        kind: 'table_split',
        column: '',
        rowIndex: null,
        original: split.marker ?? '',
        suggested: `table ${split.index} of ${splits.length} · source rows ${split.firstRow}–${split.lastRow}`,
        confidence: 0.9,
        reason: split.marker
          ? `the file continues after a section marker ("${split.marker}") with a different table; kept as its own dataset with its own columns`
          : 'a second header row was found below the data; kept as its own dataset with its own columns',
        applied: true,
      };
      dataset.review.push(item);
      dataset.report.reviewItems.push(item);
    }
  }

  emit({ pct: 94, stage: 'report', message: 'Compiling quality report' });
  emit({ pct: 100, stage: 'done', message: 'Done' });
  return datasets;
}
