// @vitest-environment node
/**
 * Offline proof for every input type, in real Chrome.
 *
 * The privacy claim is not "we do not upload" but "there is nothing to upload
 * to". This test cuts the network off and then converts every sample type —
 * including OCR, which is the one path that needs extra engine files — and
 * requires:
 *
 *   - each file to finish with a result (or a readable refusal, never a hang);
 *   - zero requests that leave the app origin;
 *   - zero failed requests for same-origin app assets (a cache miss would show
 *     up here rather than as a blank screen).
 *
 * OCR assets are warmed once while online, then the context goes offline: that
 * is the real second-visit case, where the service worker serves the engine from
 * its cache.
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

    // First visit, online: the service worker installs and precaches the shell
    // and every content-hashed bundle.
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return;
      await navigator.serviceWorker.ready;
    });

    // Warm the OCR engine while the network is still up. Everything it fetches
    // lives under /tess and /tessdata, which the worker caches cache-first.
    await page.setInputFiles('input[type=file]', path.join(SAMPLES_DIR, OCR_SAMPLE));
    expect(await waitForOutcome(page)).toBe('ready');

    const sameOrigin = new Set<string>();
    const external: string[] = [];
    const failed: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith(base) || url.startsWith('blob:') || url.startsWith('data:')) sameOrigin.add(url);
      else external.push(url);
    });
    page.on('requestfailed', (request) => {
      const url = request.url();
      const reason = request.failure()?.errorText ?? 'failed';
      // Offline navigations and the (deliberate) failed network-first shell
      // request are expected; anything else is a real cache miss.
      if (reason.includes('ERR_INTERNET_DISCONNECTED') || reason.includes('ERR_FAILED')) {
        if (!/^(\/|\.\/|index\.html)/.test(url.slice(base.length))) failed.push(`${url} — ${reason}`);
      } else {
        failed.push(`${url} — ${reason}`);
      }
    });

    await context?.setOffline(true);

    // Reload with no network: this only works if the worker serves the shell.
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.trim().length > 0, undefined, { timeout: 60_000 });

    const samples = listSamples();
    expect(samples.length).toBeGreaterThan(15);

    const failures: string[] = [];
    const seen: string[] = [];
    for (const name of samples) {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.body.innerText.trim().length > 0, undefined, { timeout: 60_000 });
      const before = Date.now();
      await page.setInputFiles('input[type=file]', path.join(SAMPLES_DIR, name));
      let result: 'ready' | 'refused' | 'threw' = 'threw';
      try {
        result = await waitForOutcome(page);
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`);
      }
      const elapsed = Date.now() - before;
      seen.push(`${name}: ${result} in ${elapsed} ms`);
      // Every fixture under samples/dev is a supported, valid file: offline it
      // must produce a table, exactly as it does online.
      if (result !== 'ready') failures.push(`${name}: ${result} offline`);
      if (result === 'ready' && OCR_SAMPLE === name) {
        const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
        if (text.trim().length < 20) failures.push(`${name}: OCR produced no text offline`);
      }
    }

    // Printed so a green run is auditable: every file, its verdict and time.
    console.log(seen.join('\n'));
    expect(external, `requests left the origin while offline:\n${external.join('\n')}`).toEqual([]);
    expect(failed, `same-origin assets failed offline:\n${failed.join('\n')}`).toEqual([]);
    expect(failures, `${failures.join('\n')}\n\n${seen.join('\n')}`).toEqual([]);
    // The worker must have served the app: a blank page would have thrown above.
    expect(sameOrigin.size).toBeGreaterThan(0);
  }, 900_000);
});
