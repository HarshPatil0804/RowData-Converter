// @vitest-environment node
/**
 * Offline proof for every input type, in real Chrome.
 *
 * The app ships no service worker, so there is no offline *reload*: a page
 * cannot be reopened without a network. What this test proves instead is the
 * claim the privacy charter actually makes — once a page is open, no processing
 * needs the network at all.
 *
 * Phase 1 (online): convert every sample once, which pulls in every lazily
 * imported parser chunk and the OCR engine files.
 * Phase 2 (offline, same page, no navigation): convert every sample again and
 * require a result for each, with **zero failed requests**.
 *
 * The page may still ask its own cache for the files a fresh engine worker
 * needs (pdf.js's worker script, Tesseract's core and language data — each is
 * created per conversion). With the network off those requests can only be
 * answered locally, which is exactly what this test relies on: every attempt
 * must be a same-origin GET for an app asset that answers `200`, and none may
 * fail. Anything that is not cached would fail, so a green run proves every
 * dependency was already on the machine.
 *
 * Cache Storage and the service-worker registry must stay empty throughout:
 * everything above is the browser's ordinary HTTP cache, which the app neither
 * reads nor writes by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, startDistServer, type DistServer } from './support/dist-server';
import { listSamples, SAMPLES_DIR } from './helpers';
import type { Browser, BrowserContext, Page } from 'playwright-core';

const BUILT = fs.existsSync(path.resolve('dist/index.html'));
const describeOffline = BUILT ? describe : describe.skip;
const OCR_SAMPLE = 'scanned_table.png';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Path only, so the log groups cache hits for the same asset. */
const urlOf = (value: string): string => {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
};

/**
 * Wait for the app's verdict. The refusal must come from the alert region —
 * the landing page's own copy mentions limits, so matching free text would
 * "pass" before the file was read.
 */
async function waitForOutcome(tab: Page, timeoutMs = 240_000): Promise<'ready' | 'refused'> {
  const started = Date.now();
  for (;;) {
    const state = await tab.evaluate(() => {
      const heading = Array.from(document.querySelectorAll('h2')).some((node) =>
        (node.textContent ?? '').includes('Your data is ready'),
      );
      const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
        .map((node) => node.textContent ?? '')
        .join(' ');
      return { ready: heading, refused: alerts.trim().length > 0 };
    });
    if (state.ready) return 'ready';
    if (state.refused) return 'refused';
    if (Date.now() - started > timeoutMs) throw new Error(`no outcome after ${timeoutMs} ms`);
    await sleep(150);
  }
}

/** Back to the upload screen without a page load — the page stays open. */
async function restart(tab: Page): Promise<void> {
  const button = tab.getByRole('button', { name: /Process more files/i }).first();
  if (await button.count()) await button.click();
  await sleep(100);
}

async function browserHolds(tab: Page) {
  return tab.evaluate(async () => ({
    caches: typeof caches === 'undefined' ? [] : await caches.keys(),
    serviceWorkers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope) : [],
  }));
}

describeOffline('offline conversions, every input type, in the built app', () => {
  let server: DistServer | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let tab: Page | null = null;

  beforeAll(async () => {
    if (!BUILT) return;
    server = await startDistServer();
    browser = await launchBrowser();
    context = await browser.newContext();
    tab = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server?.close();
  }, 60_000);

  it('converts every sample with the network switched off', async () => {
    const page = tab as Page;
    const base = (server as DistServer).base;
    const samples = listSamples();
    expect(samples.length).toBeGreaterThan(15);

    await page.goto(base, { waitUntil: 'domcontentloaded' });

    // --- phase 1: online warm-up -----------------------------------------
    // A page load per sample, because that is how a first visit would happen.
    // Every parser chunk and the OCR engine land in the browser's HTTP cache.
    const warmed: string[] = [];
    for (const name of samples) {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.setInputFiles('input[type=file]', path.join(SAMPLES_DIR, name));
      const outcome = await waitForOutcome(page);
      warmed.push(`${name}: ${outcome} (online)`);
      expect(outcome, `${name} online`).toBe('ready');
    }

    const beforeOffline = await browserHolds(page);
    expect(beforeOffline, 'no service worker may be installed').toEqual({ caches: [], serviceWorkers: [] });

    // --- phase 2: offline, no navigation ---------------------------------
    const attempted: { method: string; url: string; body: number }[] = [];
    const wrong: string[] = [];
    const failed: string[] = [];
    page.on('request', (request) => {
      attempted.push({ method: request.method(), url: request.url(), body: request.postDataBuffer()?.byteLength ?? 0 });
      if (request.method() !== 'GET') wrong.push(`NON-GET ${request.method()} ${request.url()}`);
      if ((request.postDataBuffer()?.byteLength ?? 0) > 0) wrong.push(`BODY ${request.url()}`);
      if (!request.url().startsWith(base)) wrong.push(`NOT-APP ${request.url()}`);
    });
    page.on('response', (response) => {
      if (!response.url().startsWith(base)) return;
      if (response.status() >= 400) wrong.push(`HTTP ${response.status()} ${response.url()}`);
    });
    page.on('requestfailed', (request) => {
      failed.push(`${request.url()} — ${request.failure()?.errorText ?? 'failed'}`);
    });

    await (context as BrowserContext).setOffline(true);

    const failures: string[] = [];
    const seen: string[] = [];
    for (const name of samples) {
      await restart(page);
      const started = Date.now();
      await page.setInputFiles('input[type=file]', path.join(SAMPLES_DIR, name));
      let result: 'ready' | 'refused' | 'threw' = 'threw';
      try {
        result = await waitForOutcome(page);
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`);
      }
      const elapsed = Date.now() - started;
      seen.push(`${name}: ${result} in ${elapsed} ms (offline)`);
      // Every fixture under samples/dev is a supported, valid file: offline it
      // must produce a table, exactly as it does online.
      if (result !== 'ready') failures.push(`${name}: ${result} offline`);
      if (result === 'ready' && OCR_SAMPLE === name) {
        const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
        if (text.trim().length < 20) failures.push(`${name}: OCR produced no text offline`);
      }
    }

    const afterOffline = await browserHolds(page);
    await (context as BrowserContext).setOffline(false);

    // Printed so a green run is auditable: every file, its verdict and time.
    console.log([...warmed, ...seen].join('\n'));
    console.log(`offline requests, all cache-answered: ${attempted.length}`);
    for (const url of new Set(attempted.map((item) => urlOf(item.url)))) console.log(`  ${url}`);
    expect(failed, `requests failed offline:\n${failed.join('\n')}`).toEqual([]);
    expect(wrong, `offline requests that were not plain same-origin GETs:\n${wrong.join('\n')}`).toEqual([]);
    expect(failures, `${failures.join('\n')}\n\n${seen.join('\n')}`).toEqual([]);
    expect(afterOffline, 'Cache Storage and the worker registry stay empty').toEqual({ caches: [], serviceWorkers: [] });
  }, 900_000);
});
