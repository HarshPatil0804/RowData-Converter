import { processBytes } from '../pipeline/index';
import type { DateOrderMode } from '../lib/dates';
import type { Dataset, ProgressUpdate } from '../types';

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
    ctx.postMessage({ type: 'result', id, datasets });
  } catch (error) {
    ctx.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
