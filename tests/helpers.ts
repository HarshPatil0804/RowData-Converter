import fs from 'node:fs';
import path from 'node:path';
import { processBytes } from '../src/pipeline/index';
import type { Dataset, ProgressUpdate } from '../src/types';

// jsdom serves modules over an http:// origin, so import.meta.url is not a
// file:// URL. Resolve the samples directory from this process' cwd instead.
// Development fixtures live in samples/dev; user-dropped held-out files live
// in samples/heldout (invariants + report only, never exact numbers).
export const SAMPLES_DIR = path.resolve(process.cwd(), 'samples', 'dev');
export const SAMPLES_ROOT = path.resolve(process.cwd(), 'samples');

const MIME: Record<string, string> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  xml: 'application/xml',
  yaml: 'text/yaml',
  html: 'text/html',
  md: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  eml: 'message/rfc822',
  rtf: 'application/rtf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  zip: 'application/zip',
  png: 'image/png',
};

export function mimeFor(name: string): string {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME[extension] ?? 'application/octet-stream';
}

export function readSample(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(SAMPLES_DIR, name)));
}

export function sampleExists(name: string): boolean {
  return fs.existsSync(path.join(SAMPLES_DIR, name));
}

export function listSamples(): string[] {
  return fs
    .readdirSync(SAMPLES_DIR)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => fs.statSync(path.join(SAMPLES_DIR, name)).isFile())
    .sort();
}

/**
 * Every sample file under /samples (dev + heldout), as paths relative to the
 * samples root. Used by the auto-discovered invariant suite and the report.
 */
export function listAllSamples(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir).sort()) {
      if (entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(SAMPLES_ROOT, full).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(SAMPLES_ROOT)) walk(SAMPLES_ROOT);
  return out;
}

/** Read a sample by its path relative to the samples root. */
export function readSampleAt(relative: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(SAMPLES_ROOT, relative)));
}

/** Run the pipeline over a sample addressed by its samples-root-relative path. */
export async function runSampleAt(relative: string): Promise<Dataset[]> {
  const name = relative.includes('/') ? relative.slice(relative.lastIndexOf('/') + 1) : relative;
  return processBytes(name, mimeFor(name), readSampleAt(relative));
}

/** Run the full pipeline over a sample file. */
export async function runSample(name: string): Promise<Dataset[]> {
  return processBytes(name, mimeFor(name), readSample(name));
}

/** Run the full pipeline over an in-memory text fixture. */
export async function runText(name: string, text: string): Promise<Dataset[]> {
  return processBytes(name, mimeFor(name), new TextEncoder().encode(text));
}

/** Collect progress events (also proves the pipeline emits updates). */
export async function runWithProgress(name: string): Promise<{ datasets: Dataset[]; events: ProgressUpdate[] }> {
  const events: ProgressUpdate[] = [];
  const datasets = await processBytes(name, mimeFor(name), readSample(name), {
    onProgress: (update) => events.push(update),
  });
  return { datasets, events };
}
