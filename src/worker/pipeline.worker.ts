import { processBytes } from '../pipeline/index';
import type { DateOrderMode } from '../lib/dates';
import type { Cell, Dataset, ProgressUpdate } from '../types';

/**
 * Structured-clone cost lands on the receiving (main) thread, so a 500k-row
 * dataset posted in one go shows up as a single long task. Rows are streamed
 * in slices instead and reassembled by the client.
 */
const ROW_CHUNK = 50_000;

interface WorkerRequest {
  id: number;
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

const ctx = self as unknown as {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
};

ctx.addEventListener('message', async (event) => {
  const { id, name, mime, buffer, dateOrder, acceptReviews } = event.data;
  try {
    const datasets = await processBytes(name, mime, new Uint8Array(buffer), {
      dateOrder,
      acceptReviews,
      onProgress: (progress) => ctx.postMessage({ type: 'progress', id, progress }),
    });
    // Stream large row sets, then send the datasets with their rows emptied so
    // nothing huge crosses the boundary in a single message.
    const payload = datasets.map((dataset, index) => {
      if (dataset.rows.length <= ROW_CHUNK) return dataset;
      for (let start = 0; start < dataset.rows.length; start += ROW_CHUNK) {
        ctx.postMessage({ type: 'rows', id, index, rows: dataset.rows.slice(start, start + ROW_CHUNK) });
      }
      return { ...dataset, rows: [] };
    });
    ctx.postMessage({ type: 'result', id, datasets: payload });
  } catch (error) {
    ctx.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
