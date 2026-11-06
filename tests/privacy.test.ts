// @vitest-environment node
/**
 * Tasks A, E and F: what a full session leaves behind, what it asks the network
 * for, and whether a value from inside a file can escape its two allowed
 * places (the page and the downloaded file).
 *
 * Runs the production build in real Chrome through the same headers Vercel
 * sends. Nothing here is a unit test of app code: the browser is the subject.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, startDistServer, type DistServer } from './support/dist-server';
import type { Browser, BrowserContext, Page } from 'playwright-core';

const BUILT = fs.existsSync(path.resolve('dist/index.html'));
const describePrivacy = BUILT ? describe : describe.skip;
const SAMPLES = path.resolve('samples/dev');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Observed {
  method: string;
  url: string;
  bodyBytes: number;
  resourceType: string;
}

const CANARY = 'Zq7-canary-9c1f4b';

async function ready(page: Page, timeoutMs = 240_000): Promise<void> {
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('h2')).some((h) => (h.textContent ?? '').includes('Your data is ready')),
    undefined,
    { timeout: timeoutMs },
  );
}

async function restart(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /Process more files/i }).first();
  if (await button.count()) await button.click();
  await sleep(150);
}

async function upload(page: Page, file: string): Promise<void> {
  await page.setInputFiles('input[type=file]', file);
  await ready(page);
}

async function download(page: Page, name: string): Promise<string> {
  const button = page.getByRole('button', { name, exact: true }).first();
  const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const filePath = await file.path();
  return fs.readFileSync(filePath, 'utf8');
}

async function chooseModes(page: Page): Promise<void> {
  const tabular = page.getByRole('button', { name: 'Tabular', exact: false }).first();
  if (await tabular.count()) await tabular.click();
  const spreadsheetSafe = page.getByLabel('Spreadsheet-safe export').first();
  if (await spreadsheetSafe.count()) await spreadsheetSafe.click();
  const explode = page.getByLabel('Explode multi-item rows').first();
  if (await explode.count()) await explode.click();
  const pivot = page.getByRole('button', { name: 'Pivot', exact: false }).first();
  if (await pivot.count()) await pivot.click();
}

async function browserHolds(page: Page) {
  return page.evaluate(async () => {
    const cached = typeof caches === 'undefined' ? [] : await caches.keys();
    return {
      cookies: document.cookie,
      localStorage: Object.fromEntries(Object.entries(localStorage)),
      sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
      indexedDB: indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name) : [],
      caches: cached,
      serviceWorkers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope) : [],
      opfs: navigator.storage?.getDirectory
        ? await (async () => {
            const root = (await navigator.storage.getDirectory()) as unknown as {
              entries: () => AsyncIterable<[string, unknown]>;
            };
            const names: string[] = [];
            for await (const [name] of root.entries()) names.push(name);
            return names;
          })()
        : [],
    };
  });
}

const EMPTY = {
  cookies: '',
  localStorage: {},
  sessionStorage: {},
  indexedDB: [],
  caches: [],
  serviceWorkers: [],
  opfs: [],
};

describePrivacy('privacy charter, measured in a real browser', () => {
  let server: DistServer | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  beforeAll(async () => {
    if (!BUILT) return;
    server = await startDistServer();
    browser = await launchBrowser();
    context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server?.close();
  }, 60_000);

  // ---------------------------------------------------------------- A ----
  it('A: a full session leaves zero cookies, storage, caches or workers', async () => {
    const tab = page as Page;
    const base = (server as DistServer).base;
    await tab.goto(base, { waitUntil: 'domcontentloaded' });

    await upload(tab, path.join(SAMPLES, 'messy_sales.csv'));
    await chooseModes(tab);
    await tab.getByRole('button', { name: 'Tabular', exact: false }).first().click();
    await download(tab, 'Download CSV');
    await tab.getByRole('button', { name: 'Download JSON', exact: true }).first().click().catch(() => undefined);
    await tab.getByRole('button', { name: 'Download quality report' }).first().click().catch(() => undefined);

    // Theme toggle is in-session only: flip it and require no key appears.
    await tab.getByRole('button', { name: /toggle dark mode/i }).click();
    const duringSession = await browserHolds(tab);

    await tab.getByRole('button', { name: /Clear data/ }).first().click();
    await sleep(600);
    const after = await browserHolds(tab);

    // Raw evidence for the report.
    console.log(JSON.stringify({ duringSession, afterClear: after, cookies: await (context as BrowserContext).cookies() }, null, 2));

    expect(duringSession.localStorage, 'no preference may be written, even mid-session').toEqual({});
    expect(duringSession.serviceWorkers).toEqual([]);
    expect(duringSession.caches).toEqual([]);
    expect(after).toEqual(EMPTY);
    expect(await (context as BrowserContext).cookies()).toEqual([]);
  }, 300_000);

  // ---------------------------------------------------------------- E ----
  it('E: every request in a full session is a same-origin GET with no body', async () => {
    const tab = page as Page;
    const base = (server as DistServer).base;
    const observed: Observed[] = [];
    const failures: string[] = [];

    tab.on('request', (request) => {
      const url = request.url();
      const body = request.postDataBuffer();
      observed.push({
        method: request.method(),
        url,
        bodyBytes: body ? body.byteLength : 0,
        resourceType: request.resourceType(),
      });
      if (request.method() !== 'GET') failures.push(`NON-GET ${request.method()} ${url}`);
      if (body && body.byteLength > 0) failures.push(`BODY ${body.byteLength}B ${url}`);
      if (!url.startsWith(base) && !url.startsWith('data:') && !url.startsWith('blob:')) {
        failures.push(`CROSS-ORIGIN ${url}`);
      }
      if (request.resourceType() === 'websocket' || request.resourceType() === 'eventsource') {
        failures.push(`STREAM ${request.resourceType()} ${url}`);
      }
    });

    const beaconCalls: string[] = [];
    tab.on('console', (message) => {
      const text = message.text();
      if (/sendBeacon|WebSocket|EventSource/.test(text)) beaconCalls.push(text.slice(0, 160));
    });
    await tab.addInitScript(() => {
      const flags = { beacon: 0, websocket: 0, eventsource: 0, keepalive: 0 };
      (window as unknown as { __netFlags: typeof flags }).__netFlags = flags;
      const sendBeacon = navigator.sendBeacon?.bind(navigator);
      if (sendBeacon) {
        navigator.sendBeacon = (...args: Parameters<typeof sendBeacon>) => {
          flags.beacon += 1;
          return sendBeacon(...args);
        };
      }
      const OriginalWebSocket = window.WebSocket;
      window.WebSocket = class extends OriginalWebSocket {
        constructor(...args: ConstructorParameters<typeof OriginalWebSocket>) {
          flags.websocket += 1;
          super(...args);
        }
      } as typeof WebSocket;
      const OriginalEventSource = window.EventSource;
      if (OriginalEventSource) {
        window.EventSource = class extends OriginalEventSource {
          constructor(...args: ConstructorParameters<typeof OriginalEventSource>) {
            flags.eventsource += 1;
            super(...args);
          }
        } as typeof EventSource;
      }
      const originalFetch = window.fetch;
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.keepalive) flags.keepalive += 1;
        return originalFetch(input, init);
      };
    });

    await tab.goto(base, { waitUntil: 'domcontentloaded' });

    for (const name of ['messy_sales.csv', 'products.xlsx', 'inventory_table.pdf', 'scanned_table.png', 'data_dump.zip']) {
      await tab.goto(base, { waitUntil: 'domcontentloaded' });
      await upload(tab, path.join(SAMPLES, name));
      await tab.getByRole('button', { name: 'Tabular', exact: false }).first().click();
      await download(tab, 'Download CSV');
      await download(tab, 'Download XLSX');
      await tab.getByRole('button', { name: 'Download quality report' }).first().click();
      await sleep(150);
      await chooseModes(tab);
      await sleep(150);
      await restart(tab);
    }

    await tab.getByRole('button', { name: /Clear data/ }).first().click();
    await sleep(300);

    const netFlags = await tab.evaluate(() => (window as unknown as { __netFlags: Record<string, number> }).__netFlags);
    const summary = {
      requests: observed.length,
      methods: [...new Set(observed.map((o) => o.method))],
      origins: [...new Set(observed.map((o) => new URL(o.url).origin))],
      withBody: observed.filter((o) => o.bodyBytes > 0).length,
      netFlags,
      byResourceType: observed.reduce<Record<string, number>>((acc, item) => {
        acc[item.resourceType] = (acc[item.resourceType] ?? 0) + 1;
        return acc;
      }, {}),
    };
    console.log(JSON.stringify({ summary, failures }, null, 2));

    expect(failures, failures.slice(0, 10).join('\n')).toEqual([]);
    expect(netFlags).toEqual({ beacon: 0, websocket: 0, eventsource: 0, keepalive: 0 });
    expect(observed.length).toBeGreaterThan(10);
  }, 600_000);

  // ---------------------------------------------------------------- F ----
  it('F: a canary in a cell and a filename stays in the DOM and the download', async () => {
    const tab = page as Page;
    const base = (server as DistServer).base;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2s-canary-'));
    const file = path.join(dir, `${CANARY}-invoice.csv`);
    fs.writeFileSync(
      file,
      `customer,note,amount\n${CANARY} Ltd,"paid ${CANARY}",12.50\nOther,nothing,3.00\n`,
      'utf8',
    );

    const consoleText: string[] = [];
    const requestText: string[] = [];
    tab.on('console', (message) => consoleText.push(`${message.type()}: ${message.text()}`));
    tab.on('pageerror', (error) => consoleText.push(`pageerror: ${error.message}`));
    tab.on('request', (request) => {
      requestText.push(`${request.method()} ${request.url()}`);
      const body = request.postData();
      if (body) requestText.push(`BODY ${body}`);
    });

    await tab.goto(base, { waitUntil: 'domcontentloaded' });
    await upload(tab, file);
    await tab.getByRole('button', { name: 'Tabular', exact: false }).first().click();
    const domBefore = await tab.evaluate(() => document.body.innerText);
    const csv = await download(tab, 'Download CSV');
    const during = await browserHolds(tab);
    const title = await tab.title();
    const href = tab.url();

    await tab.getByRole('button', { name: /Clear data/ }).first().click();
    await sleep(500);
    const afterClear = await tab.evaluate(() => document.body.innerText);
    const storageAfter = await browserHolds(tab);

    fs.rmSync(dir, { recursive: true, force: true });

    const evidence = {
      inDom: domBefore.includes(CANARY),
      inDownload: csv.includes(CANARY),
      inConsole: consoleText.filter((line) => line.includes(CANARY)).length,
      inRequests: requestText.filter((line) => line.includes(CANARY)).length,
      inTitle: title.includes(CANARY),
      inUrl: href.includes(CANARY),
      inStorage: JSON.stringify(during).includes(CANARY),
      afterClear,
    };
    console.log(JSON.stringify(evidence, null, 2));

    expect(evidence.inDom, 'the value must be visible where the user is looking').toBe(true);
    expect(evidence.inDownload, 'the value must reach the downloaded file').toBe(true);
    expect(evidence.inConsole).toBe(0);
    expect(evidence.inRequests).toBe(0);
    expect(evidence.inTitle).toBe(false);
    expect(evidence.inUrl).toBe(false);
    expect(evidence.inStorage).toBe(false);
    expect(afterClear.includes(CANARY), 'Clear data must remove it from the page').toBe(false);
    expect(storageAfter).toEqual(EMPTY);
  }, 300_000);
});
