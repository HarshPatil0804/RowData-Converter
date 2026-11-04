// @vitest-environment node
/**
 * Browser parity: the tests run the pipeline in Node, production runs it in a
 * browser worker. That gap hid a real defect — every .docx failed live (mammoth's
 * browser build reads `arrayBuffer`, its Node build reads `buffer`) while the
 * suite stayed green.
 *
 * This suite closes the gap. For every sample it:
 *   1. runs the pipeline in-process (Node) and builds the CSV the app would export;
 *   2. serves the production bundle (`vite preview` → `dist/`) and uploads the
 *      same file to headless Chromium;
 *   3. downloads the CSV the app produces and compares it byte for byte.
 *
 * Any difference in parsing, cleaning, formatting or export fails here, in CI,
 * before a deploy.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { listSamples, mimeFor, readSample } from './helpers';
import { processBytes } from '../src/pipeline/index';
import { toCSV } from '../src/lib/export';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const PORT = 4327;
const BASE = `http://localhost:${PORT}`;
const BUILT = fs.existsSync(path.join(DIST, 'index.html'));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${BASE}/`, { cache: 'no-store' });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() - started > timeoutMs) throw new Error(`vite preview did not answer on ${BASE}`);
    await sleep(250);
  }
}

function startPreview(): ChildProcess {
  const bin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  return spawn(process.execPath, [bin, 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Wait for the app's own verdict: success or a per-file failure. */
async function waitForResult(tab: Page, timeoutMs = 180_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const state = await tab.evaluate(() => {
      const body = document.body.innerText;
      return {
        ready: body.includes('Your data is ready'),
        failed: /could not be processed/i.test(body),
      };
    });
    if (state.ready) return;
    if (state.failed) {
      const message = await tab.evaluate(() => {
        const body = document.body.innerText.replace(/\s+/g, ' ');
        const at = body.search(/could not be processed/i);
        return body.slice(at, at + 240);
      });
      throw new Error(message);
    }
    if (Date.now() - started > timeoutMs) throw new Error(`no result after ${timeoutMs} ms`);
    await sleep(100);
  }
}

function firstDifference(actual: string, expected: string): string {
  const a = actual.split('\n');
  const b = expected.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? '') !== (b[i] ?? '')) {
      return `line ${i + 1}\n    browser: ${JSON.stringify((a[i] ?? '<missing>').slice(0, 160))}\n    node:    ${JSON.stringify((b[i] ?? '<missing>').slice(0, 160))}`;
    }
  }
  return 'identical';
}

const describeParity = BUILT ? describe : describe.skip;

describeParity('browser parity: production bundle vs Node pipeline', () => {
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  beforeAll(async () => {
    if (!BUILT) return;
    server = startPreview();
    await waitForServer();
    try {
      browser = await chromium.launch({ headless: true, channel: 'chrome' });
    } catch {
      browser = await chromium.launch({ headless: true });
    }
    context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    server?.kill();
  }, 60_000);

  it('every sample exports exactly what the Node pipeline computes', async () => {
    const samples = listSamples();
    expect(samples.length).toBeGreaterThan(15);
    const failures: string[] = [];
    const tab = page as Page;

    for (const name of samples) {
      const datasets = await processBytes(name, mimeFor(name), readSample(name));
      const expected = toCSV(datasets[0].columns, datasets[0].rows);

      await tab.goto(BASE, { waitUntil: 'domcontentloaded' });
      await tab.setInputFiles('input[type=file]', path.join(ROOT, 'samples', 'dev', name));
      try {
        await waitForResult(tab);
      } catch (error) {
        failures.push(`${name}: app failed — ${(error as Error).message}`);
        continue;
      }

      await tab.getByRole('button', { name: 'Tabular', exact: false }).first().click();
      const button = tab.getByRole('button', { name: 'Download CSV' }).first();
      await button.waitFor({ timeout: 30_000 });
      let actual = '';
      try {
        const [download] = await Promise.all([tab.waitForEvent('download'), button.click()]);
        const file = await download.path();
        actual = fs.readFileSync(file, 'utf8');
      } catch (error) {
        failures.push(`${name}: no download — ${(error as Error).message.split('\n')[0]}`);
        continue;
      }

      if (actual !== expected) {
        failures.push(`${name}: CSV differs from Node output — ${firstDifference(actual, expected)}`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  }, 300_000);
});
