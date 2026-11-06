// @vitest-environment node
/**
 * Determinism: the same input must produce the same bytes everywhere.
 *
 * Two halves, because two different clocks and calendars can leak into output:
 *
 *  1. Node, repeated runs. The pipeline and every export are run twice and
 *     must hash identically — this catches map/object iteration order, not the
 *     clock (Node cannot change its default locale, and switching `TZ` after
 *     startup does not reach every library, so time zones are proven in the
 *     browser instead of by a half-working switch here).
 *  2. Chrome, four time zones × four locales. The real production bundle is
 *     loaded in a context with that `timezoneId` and `locale`, and the files a
 *     user would download — tabular CSV, tabular XLSX, quality report, pivot
 *     CSV — are hashed. All sixteen must agree.
 *
 * Locale is the interesting half: `Number.prototype.toLocaleString()` and
 * `Intl.*` silently follow the browser's locale, so a single stray call in an
 * export path shows up here as a differing byte.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { launchBrowser, startDistServer, type DistServer } from './support/dist-server';
import { listSamples, mimeFor, readSample } from './helpers';
import { processBytes } from '../src/pipeline/index';
import {
  datasetToSheets,
  pivotToMatrix,
  pivotToSheets,
  qualityToCSV,
  toCSV,
  toJSON,
  workbookFromSheets,
} from '../src/lib/export';
import { computePivot, suggestPivot } from '../src/lib/pivot';

const TIME_ZONES = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Auckland'];
const LOCALES = ['en-US', 'en-IN', 'de-DE', 'fr-FR'];
const NODE_SAMPLES = [
  'messy_sales.csv',
  'messy_real_orders.csv',
  'products.xlsx',
  'inventory_table.pdf',
  'nested_customers.json',
  'report.html',
  'events.ndjson',
];
const BROWSER_SAMPLE = 'messy_real_orders.csv';
const DIST = path.resolve('dist/index.html');
const SAMPLES = path.resolve('samples/dev');

const digest = (value: string | Uint8Array): string =>
  crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every artifact the app can produce for one input. */
async function nodeHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const available = new Set(listSamples());
  for (const name of NODE_SAMPLES) {
    if (!available.has(name)) continue;
    const [dataset] = await processBytes(name, mimeFor(name), readSample(name));
    hashes[`${name}:csv`] = digest(toCSV(dataset.columns, dataset.rows, { types: dataset.types }));
    hashes[`${name}:csv-safe`] = digest(
      toCSV(dataset.columns, dataset.rows, { types: dataset.types, spreadsheetSafe: true }),
    );
    hashes[`${name}:json`] = digest(toJSON(dataset.columns, dataset.rows));
    hashes[`${name}:xlsx`] = digest(workbookFromSheets(datasetToSheets(dataset)));
    hashes[`${name}:report`] = digest(qualityToCSV(dataset.report));
    const pivot = computePivot(dataset, suggestPivot(dataset));
    const matrix = pivotToMatrix(pivot);
    hashes[`${name}:pivot-csv`] = digest(toCSV(matrix.columns, matrix.rows));
    hashes[`${name}:pivot-xlsx`] = digest(workbookFromSheets(pivotToSheets(dataset, pivot)));
  }
  return hashes;
}

function firstDifference(a: Record<string, string>, b: Record<string, string>): string {
  for (const key of Object.keys(b)) {
    if (a[key] !== b[key]) return `${key}: ${a[key]} vs ${b[key]}`;
  }
  return 'identical';
}

describe('determinism', () => {
  it('Node: repeated runs of the pipeline and every export are byte-identical', async () => {
    const first = await nodeHashes();
    expect(Object.keys(first).length).toBeGreaterThan(30);
    const second = await nodeHashes();
    console.log(JSON.stringify(first, null, 2));
    expect(firstDifference(second, first), 'two runs of the same input produced different bytes').toBe('identical');
  }, 300_000);
});

const describeBrowser = fs.existsSync(DIST) ? describe : describe.skip;

describeBrowser('determinism in the built app', () => {
  let server: DistServer | null = null;
  let browser: Browser | null = null;

  beforeAll(async () => {
    server = await startDistServer();
    browser = await launchBrowser();
  }, 180_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await server?.close();
  }, 60_000);

  async function waitForResult(page: Page, timeoutMs = 180_000): Promise<void> {
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('h2')).some((h) => (h.textContent ?? '').includes('Your data is ready')),
      undefined,
      { timeout: timeoutMs },
    );
  }

  async function grab(page: Page, name: string, timeoutMs = 30_000): Promise<string> {
    const button = page.getByRole('button', { name, exact: true }).first();
    await button.waitFor({ timeout: timeoutMs });
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: timeoutMs }), button.click()]);
    return digest(fs.readFileSync((await download.path()) as string));
  }

  async function contextHashes(locale: string, timezoneId: string): Promise<Record<string, string>> {
    const context = (await (browser as Browser).newContext({ acceptDownloads: true, locale, timezoneId })) as BrowserContext;
    const page = await context.newPage();
    try {
      await page.goto((server as DistServer).base, { waitUntil: 'domcontentloaded' });
      await page.setInputFiles('input[type=file]', path.join(SAMPLES, BROWSER_SAMPLE));
      await waitForResult(page);

      const hashes: Record<string, string> = {};
      await page.getByRole('button', { name: 'Tabular', exact: false }).first().click();
      hashes.csv = await grab(page, 'Download CSV');
      hashes.xlsx = await grab(page, 'Download XLSX');
      hashes.json = await grab(page, 'Download JSON');
      hashes.report = await grab(page, 'Download quality report');

      await page.getByRole('button', { name: 'Pivot table', exact: false }).first().click();
      await sleep(200);
      hashes.pivotCsv = await grab(page, 'Download CSV');
      hashes.pivotXlsx = await grab(page, 'Download XLSX');
      return hashes;
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  it('Chrome: the same bytes in sixteen locale × time-zone combinations', async () => {
    const results: { locale: string; tz: string; hashes: Record<string, string>; clock: string }[] = [];
    const clocks = new Map<string, string>();
    for (const locale of LOCALES) {
      for (const tz of TIME_ZONES) {
        const context = (await (browser as Browser).newContext({ locale, timezoneId: tz })) as BrowserContext;
        const page = await context.newPage();
        // Offset in minutes: time-zone dependent, locale independent, so it can
        // be compared across locales.
        const clock = String(await page.evaluate(() => new Date(0).getTimezoneOffset()));
        const pageLocale = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().locale);
        await context.close().catch(() => undefined);
        results.push({ locale, tz, hashes: await contextHashes(locale, tz), clock });
        // Both options really reached the page. Without this the runs below
        // could all be the same context and prove nothing.
        expect(pageLocale.toLowerCase(), `locale ${locale} did not reach the page`).toContain(
          locale.split('-')[0].toLowerCase(),
        );
        const seen = clocks.get(tz);
        if (seen === undefined) clocks.set(tz, clock);
        else expect(clock, `${tz} was set inconsistently`).toBe(seen);
      }
    }
    expect(new Set(clocks.values()).size, 'timezoneId had no effect in the page').toBe(TIME_ZONES.length);

    console.log(
      results.map((row) => `${row.locale} ${row.tz} ${JSON.stringify(row.hashes)}`).join('\n'),
    );
    const baseline = results[0].hashes;
    expect(Object.keys(baseline).length).toBe(6);
    for (const row of results.slice(1)) {
      expect(firstDifference(row.hashes, baseline), `${row.locale} / ${row.tz} changed the bytes`).toBe('identical');
    }
  }, 900_000);
});
