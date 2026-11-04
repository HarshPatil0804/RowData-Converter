import type { DateOrderMode } from '../lib/dates';
import type { Cell, Dataset, ProgressUpdate } from '../types';

export interface ProcessJob {
  name: string;
  mime: string;
  buffer: ArrayBuffer;
  /** R3 – how to read patterns the file never proves ('auto' | DM | MD). */
  dateOrder?: DateOrderMode;
  /** Accepted review items – their suggestions are applied on this run. */
  acceptReviews?: string[];
}

type WorkerResponse =
  | { type: 'progress'; id: number; progress: ProgressUpdate }
  | { type: 'rows'; id: number; index: number; rows: Cell[][] }
  | { type: 'result'; id: number; datasets: Dataset[] }
  | { type: 'error'; id: number; message: string };

interface Pending {
  resolve: (datasets: Dataset[]) => void;
  reject: (error: Error) => void;
  onProgress?: (update: ProgressUpdate) => void;
  /** Rows streamed in chunks by the worker, keyed by dataset index. */
  rows?: Cell[][][];
}

/**
 * Thin client around the pipeline Web Worker: the heavy detect/extract/clean
 * work runs off the main thread so the UI never freezes.
 */
export class PipelineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      if (message.type === 'progress') {
        entry.onProgress?.(message.progress);
        return;
      }
      if (message.type === 'rows') {
        entry.rows ??= [];
        const bucket = (entry.rows[message.index] ??= []);
        for (const row of message.rows) bucket.push(row);
        return;
      }
      this.pending.delete(message.id);
      if (message.type === 'result') {
        const chunks = entry.rows;
        entry.resolve(
          chunks
            ? message.datasets.map((dataset, index) => ({ ...dataset, rows: chunks[index] ?? dataset.rows }))
            : message.datasets,
        );
      } else entry.reject(new Error(message.message));
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'Worker failed');
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
  }

  process(job: ProcessJob, onProgress?: (update: ProgressUpdate) => void): Promise<Dataset[]> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<Dataset[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, ...job }, [job.buffer]);
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const entry of this.pending.values()) entry.reject(new Error('Cancelled'));
    this.pending.clear();
  }
}
