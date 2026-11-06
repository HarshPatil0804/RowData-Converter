#!/usr/bin/env node
/**
 * Live-site verification harness (Phases 5–7 of the deployment audit).
 *
 *   node e2e/run.mjs --base-url <url> --files <dir> --out <dir> [--mode convert|privacy|perf]
 *
 * convert (default)
 *   For every file: upload → wait for processing → choose Tabular → download
 *   the CSV to <out>/<stem>.csv. Then Pivot + XLSX, the date toggle (which
 *   re-runs the pipeline), dark mode, and a 390 px mobile pass.
 *
 * privacy
 *   Records every network request made after load while converting one file
 *   of each input type (CSV, XLSX, PDF, image, ZIP), then reports any
 *   cross-origin request and any file content found in browser storage.
 *
 * perf
 *   Loads a large CSV, measures processing wall time, longest main-thread
 *   long task (>200 ms) and JS heap usage.
 *
 * Always reports: processing time per file, console errors, failed requests.
 */
import { chromium } from 'playwright-core';
import Papa from 'papaparse';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * A snapshot, not an oracle.
 *
 * `e2e/snapshot.json` records what the Node pipeline produced for
 * `samples/dev` at the time it was generated. The parity suite proves the
 * production bundle emits the same CSV, so the numbers hold for the deployed
 * app; that makes the live run assert *content*, not just that a download
 * happened.
 *
 * Two honest limits:
 *  - It only covers files it has an entry for. Any other folder is still
 *    exercised — upload, conversion and download must succeed — but without
 *    cell-level assertions, because there is nothing to compare against.
 *  - It is a copy of the project's own output. A host that replaced both the
 *    app and this snapshot would look consistent; `scripts/verify-live.mjs`
 *    (hash of every deployed file vs. the manifest) is what makes that visible.
 *
 * The path is resolved from this file, not from the working directory, so the
 * harness runs from anywhere against any folder.
 */
const EXPECTED = JSON.parse(fs.readFileSync(new URL('./snapshot.json', import.meta.url), 'utf8')).files;

// ---------------------------------------------------------------- args -----
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

const BASE_URL = arg('base-url', 'https://row-data-converter-28tw.vercel.app');
const FILES_DIR = path.resolve(arg('files', 'samples/dev'));
const OUT_DIR = path.resolve(arg('out', 'e2e-out'));
const MODE = arg('mode', 'convert');
const BASE_ORIGIN = new URL(BASE_URL).origin;

fs.mkdirSync(OUT_DIR, { recursive: true });

/** Input types exercised by the privacy pass, in a fixed order. */
const PRIVACY_TYPES = [
  ['csv', 'messy_sales.csv'],
  ['xlsx', 'products.xlsx'],
  ['pdf', 'inventory_table.pdf'],
  ['image', 'scanned_table.png'],
  ['zip', 'data_dump.zip'],
];

const isCrossOrigin = (url) => {
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return false;
  try {
    return new URL(url).origin !== BASE_ORIGIN;
  } catch {
    return false;
  }
};

// ------------------------------------------------------------ reporting ----
const report = {
  baseUrl: BASE_URL,
  mode: MODE,
  startedAt: new Date().toISOString(),
  files: [],
  consoleErrors: [],
  failedRequests: [],
  badResponses: [],
  crossOrigin: [],
  storageFindings: [],
  contentFailures: [],
  perf: null,
  mobile: null,
  darkMode: null,
  dateToggle: null,
  pivot: null,
};

/** Context-level watcher: catches responses issued from web workers too. */
function watchContext(context, label = '') {
  context.on('response', (response) => {
    const status = response.status();
    if (status >= 400) report.badResponses.push(`${label}${status} ${response.url()}`);
    if (isCrossOrigin(response.url())) report.crossOrigin.push(`${label}RESPONSE ${status} ${response.url()}`);
  });
  context.on('request', (request) => {
    if (isCrossOrigin(request.url())) report.crossOrigin.push(`${label}REQUEST ${request.method()} ${request.url()}`);
  });
}

function watch(tab, label = '') {
  tab.on('console', (message) => {
    if (message.type() === 'error') {
      report.consoleErrors.push(`${label}${message.text()}`.slice(0, 500));
    }
  });
  tab.on('pageerror', (error) => report.consoleErrors.push(`${label}pageerror: ${error.message}`));
  tab.on('requestfailed', (request) => {
    report.failedRequests.push(`${label}${request.url()} :: ${request.failure()?.errorText}`);
  });
  tab.on('request', (request) => {
    if (isCrossOrigin(request.url())) {
      report.crossOrigin.push(`${label}REQUEST ${request.method()} ${request.url()}`);
    }
  });
  tab.on('response', (response) => {
    const status = response.status();
    if (status >= 400) report.badResponses.push(`${label}${status} ${response.url()}`);
    if (isCrossOrigin(response.url())) report.crossOrigin.push(`${label}RESPONSE ${status} ${response.url()}`);
  });
}

/** Click a button, wait for the download it triggers, save it to `dest`. */
async function grabDownload(tab, button, dest) {
  try {
    const [download] = await Promise.all([
      tab.waitForEvent('download', { timeout: 60_000 }),
      button.click(),
    ]);
    await download.saveAs(dest);
    return fs.existsSync(dest) ? dest : null;
  } catch {
    return null;
  }
}

/**
 * Wait for the app to reach a verdict: success ('Your data is ready') or a
 * per-file failure. Waiting only for success turns every rejection into a
 * five-minute stall, so the error state is reported as a real failure.
 */
async function waitForResult(tab, timeoutMs = 300_000) {
  const started = Date.now();
  for (;;) {
    const state = await tab.evaluate(() => {
      const body = document.body.innerText;
      return {
        ready: body.includes('Your data is ready'),
        failed: /could not be processed/i.test(body),
      };
    });
    if (state.ready) return 'ready';
    if (state.failed) {
      const message = await tab.evaluate(() => {
        const body = document.body.innerText.replace(/\s+/g, ' ');
        const at = body.search(/could not be processed/i);
        return body.slice(at, at + 260);
      });
      throw new Error(message);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`no result after ${timeoutMs} ms`);
    }
    await tab.waitForTimeout(250);
  }
}

function stem(name) {
  return name.replace(/\.[^.]+$/, '');
}

async function convertOne(tab, filePath, { wantPivot = true, recordIt = true } = {}) {
  const name = path.basename(filePath);
  const record = {
    file: name,
    ok: false,
    processMs: null,
    csv: null,
    xlsx: null,
    rows: null,
    content: null,
  };
  const started = Date.now();

  await tab.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await tab.setInputFiles('input[type=file]', filePath);
  await waitForResult(tab);
  record.processMs = Date.now() - started;

  const summary = await tab.locator('main').first().innerText();
  const rowsMatch = summary.match(/([\d,]+)\s+rows\s+×\s+(\d+)\s+columns/);
  if (rowsMatch) record.rows = Number(rowsMatch[1].replace(/,/g, ''));

  // Tabular → CSV
  await tab.getByRole('button', { name: 'Tabular', exact: false }).first().click();
  const csvButton = tab.getByRole('button', { name: 'Download CSV' }).first();
  await csvButton.waitFor({ timeout: 30_000 });
  record.csv = await grabDownload(tab, csvButton, path.join(OUT_DIR, `${stem(name)}.csv`));

  if (wantPivot) {
    await tab.getByRole('button', { name: 'Pivot table', exact: false }).first().click();
    const pivotXlsx = tab.getByRole('button', { name: 'Download XLSX' }).first();
    await pivotXlsx.waitFor({ timeout: 30_000 });
    record.xlsx = await grabDownload(tab, pivotXlsx, path.join(OUT_DIR, `${stem(name)}.pivot.xlsx`));
    report.pivot = { ...report.pivot, [name]: record.xlsx !== null };
  }

  // --- content check: row count and three known cells --------------------
  const expected = EXPECTED[name];
  if (record.csv && expected) {
    const parsed = Papa.parse(fs.readFileSync(record.csv, 'utf8'), { skipEmptyLines: true });
    const data = parsed.data;
    const body = data.slice(1);
    const problems = [];
    if (data.length === 0) problems.push('empty CSV');
    if (body.length !== expected.rows) problems.push(`rows ${body.length} != ${expected.rows}`);
    if ((data[0] ?? []).length !== expected.columns) {
      problems.push(`columns ${(data[0] ?? []).length} != ${expected.columns}`);
    }
    for (const [row, column, value] of expected.cells) {
      const actual = body[row]?.[column];
      if (String(actual ?? '') !== String(value)) {
        problems.push(`cell[${row},${column}] ${JSON.stringify(actual)} != ${JSON.stringify(value)}`);
      }
    }
    record.content = { ok: problems.length === 0, checked: expected.cells.length, problems };
    if (!record.content.ok) {
      report.contentFailures.push(`${name}: ${problems.join('; ')}`);
    }
  }

  // Files with no snapshot entry are checked for success only.
  record.ok = record.csv !== null && (record.content ? record.content.ok : true);
  if (recordIt) report.files.push(record);
  return record;
}

// --------------------------------------------------------------- modes -----
async function runConvert(browser, files) {
  const context = await browser.newContext({ acceptDownloads: true });
  watchContext(context);
  const tab = await context.newPage();
  watch(tab);

  for (const file of files) {
    process.stdout.write(`→ ${path.basename(file)} ... `);
    try {
      const record = await convertOne(tab, file);
      console.log(`${record.processMs} ms, rows=${record.rows ?? '?'}, csv=${record.csv ? 'saved' : 'MISSING'}`);
    } catch (error) {
      console.log(`FAILED: ${error.message.split('\n')[0]}`);
      report.files.push({ file: path.basename(file), ok: false, error: error.message.split('\n')[0] });
    }
  }

  // --- date toggle re-runs the pipeline ---------------------------------
  const first = files.find((f) => /\.(csv|tsv|txt)$/i.test(f));
  if (first) {
    await tab.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await tab.setInputFiles('input[type=file]', first);
    await waitForResult(tab);
    const label = await tab.getByRole('button', { name: /^Dates:/ }).first().innerText();
    const t0 = Date.now();
    await tab.getByRole('button', { name: /^Dates:/ }).first().click();
    await waitForResult(tab);
    report.dateToggle = { from: label, rerunMs: Date.now() - t0, ok: true };
    console.log(`date toggle: ${label} → re-run in ${report.dateToggle.rerunMs} ms`);
  }

  // --- dark mode ---------------------------------------------------------
  await tab.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const before = await tab.evaluate(() => document.documentElement.classList.contains('dark'));
  await tab.getByLabel('Toggle dark mode').click();
  await tab.waitForTimeout(200);
  const after = await tab.evaluate(() => document.documentElement.classList.contains('dark'));
  report.darkMode = { before, after, toggled: before !== after };
  console.log(`dark mode: ${before} → ${after}`);

  // --- 390 px mobile viewport -------------------------------------------
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    acceptDownloads: true,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await mobileContext.newPage();
  watch(mobile, '[mobile] ');
  const target = files.find((f) => /\.csv$/i.test(f)) ?? files[0];
  let record = null;
  try {
    record = await convertOne(mobile, target, { wantPivot: false, recordIt: false });
  } catch (error) {
    const message = error.message.split('\n')[0];
    report.files.push({ file: path.basename(target), ok: false, error: `[mobile] ${message}` });
    console.log(`mobile 390px: FAILED ${message.slice(0, 120)}`);
  }
  if (record) {
    const overflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    report.mobile = {
      file: path.basename(target),
      ok: record.ok,
      contentOk: record.content?.ok ?? false,
      horizontalOverflowPx: overflow,
    };
    console.log(`mobile 390px: ok=${record.ok} overflow=${overflow}px`);
  }
  await mobileContext.close();

  await context.close();
}

async function runPrivacy(browser) {
  const context = await browser.newContext({ acceptDownloads: true });
  watchContext(context);
  const tab = await context.newPage();
  watch(tab);

  for (const [type, name] of PRIVACY_TYPES) {
    const filePath = path.join(FILES_DIR, name);
    if (!fs.existsSync(filePath)) {
      console.log(`privacy/${type}: ${name} missing, skipped`);
      continue;
    }
    const seen = [];
    const onReq = (request) => seen.push(`${request.method()} ${request.url()}`);
    tab.on('request', onReq);
    const t0 = Date.now();
    try {
      await tab.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await tab.setInputFiles('input[type=file]', filePath);
      await waitForResult(tab, 600_000);
      console.log(`privacy/${type}: converted in ${Date.now() - t0} ms, ${seen.length} requests`);
    } catch (error) {
      console.log(`privacy/${type}: FAILED ${error.message.split('\n')[0]}`);
    }
    tab.off('request', onReq);

    const cross = seen.filter((line) => isCrossOrigin(line.split(' ')[1]));
    if (cross.length > 0) report.crossOrigin.push(...cross.map((c) => `${type}: ${c}`));

    // Is any file content sitting in browser storage?
    const findings = await tab.evaluate(async (label) => {
      const hits = [];
      const probe = (store, name) => {
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          const value = String(store.getItem(key) ?? '');
          if (/^[\x20-\x7e]{0,4000}$/.test(value) && /(customer|invoice|order|amount|@|{.*:)/i.test(value)) {
            hits.push(`${name}:${key}=${value.slice(0, 120)}`);
          }
        }
      };
      probe(localStorage, 'localStorage');
      probe(sessionStorage, 'sessionStorage');
      if (indexedDB.databases) {
        const dbs = await indexedDB.databases();
        for (const db of dbs) hits.push(`indexedDB:${db.name || '(unnamed)'}`);
      }
      const cacheUrls = [];
      if (caches?.keys) {
        for (const cache of await caches.keys()) {
          for (const req of await (await caches.open(cache)).keys()) {
            cacheUrls.push(req.url);
          }
        }
      }
      // There is no service worker and no cache policy any more: the app must
      // not write to Cache Storage at all, so every entry is a finding.
      for (const url of cacheUrls) hits.push(`cache:${url}`);
      return { hits: hits.map((h) => `${label} ${h}`), cacheEntries: cacheUrls.length };
    }, type);

    report.shellCacheEntries = Math.max(report.shellCacheEntries ?? 0, findings.cacheEntries);
    if (findings.hits.length > 0) report.storageFindings.push(...findings.hits);
    await new Promise((r) => setTimeout(r, 500));
  }

  await context.close();
}

async function runPerf(browser, filePath) {
  const context = await browser.newContext({ acceptDownloads: true });
  const tab = await context.newPage();
  watch(tab);
  await tab.addInitScript(() => {
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration));
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      /* longtask observer unsupported */
    }
  });

  const sizeMB = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);
  await tab.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  await tab.setInputFiles('input[type=file]', filePath);
  await waitForResult(tab, 1_800_000);
  const wallMs = Date.now() - t0;

  const perf = await tab.evaluate(() => {
    const memory = performance.memory
      ? {
          usedJSHeapBeforeMB: null,
          usedJSHeapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
          totalJSHeapMB: Math.round(performance.memory.totalJSHeapSize / 1048576),
        }
      : null;
    const tasks = window.__longTasks ?? [];
    return { longTasks: tasks, over200: tasks.filter((t) => t > 200).length, memory };
  });

  const summary = await tab.locator('main').first().innerText();
  const rowsMatch = summary.match(/([\d,]+)\s+rows\s+×/);
  report.perf = {
    file: path.basename(filePath),
    sizeMB,
    wallMs,
    rows: rowsMatch ? Number(rowsMatch[1].replace(/,/g, '')) : null,
    longestTaskMs: perf.longTasks.length ? Math.max(...perf.longTasks) : 0,
    tasksOver200ms: perf.over200,
    memory: perf.memory,
  };
  console.log(
    `perf: ${sizeMB} MB → ${report.perf.wallMs} ms, rows=${report.perf.rows}, ` +
      `longestTask=${report.perf.longestTaskMs} ms, >200ms=${report.perf.tasksOver200ms}, ` +
      `heap=${perf.memory?.usedJSHeapMB ?? 'n/a'} MB`,
  );
  await context.close();
}

// ----------------------------------------------------------------- main ----
async function main() {
  const launchOptions = { headless: true };
  let browser;
  try {
    browser = await chromium.launch({ ...launchOptions, channel: 'chrome' });
  } catch {
    browser = await chromium.launch(launchOptions);
  }

  try {
    if (MODE === 'privacy') {
      await runPrivacy(browser);
    } else if (MODE === 'perf') {
      const file = path.resolve(arg('file', path.join(FILES_DIR, 'perf-50mb.csv')));
      if (!fs.existsSync(file)) throw new Error(`perf input not found: ${file}`);
      await runPerf(browser, file);
    } else {
      const all = fs
        .readdirSync(FILES_DIR)
        .filter((name) => fs.statSync(path.join(FILES_DIR, name)).isFile())
        .filter((name) => !name.startsWith('.'))
        .filter((name) => !/^current_/i.test(name))
        .sort()
        .map((name) => path.join(FILES_DIR, name));
      const limit = Number(arg('limit', '0'));
      await runConvert(browser, limit > 0 ? all.slice(0, limit) : all);
    }
  } finally {
    await browser.close();
  }

  report.finishedAt = new Date().toISOString();
  const summaryPath = path.join(OUT_DIR, `report-${MODE}.json`);
  fs.writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`);

  const okFiles = report.files.filter((f) => f.ok).length;
  console.log('\n=== SUMMARY ===');
  console.log(`mode              : ${MODE}`);
  console.log(`files converted   : ${okFiles}/${report.files.length}`);
  console.log(`console errors    : ${report.consoleErrors.length}`);
  console.log(`failed requests   : ${report.failedRequests.length}`);
  console.log(`4xx/5xx responses : ${report.badResponses.length}`);
  console.log(`cross-origin reqs : ${report.crossOrigin.length}`);
  console.log(`storage findings  : ${report.storageFindings.length}`);
  console.log(`content mismatches: ${report.contentFailures.length}`);
  if (report.contentFailures.length) console.log(`  ${report.contentFailures.slice(0, 8).join('\n  ')}`);
  if (report.consoleErrors.length) console.log(`  ${report.consoleErrors.slice(0, 5).join('\n  ')}`);
  if (report.failedRequests.length) console.log(`  ${report.failedRequests.slice(0, 5).join('\n  ')}`);
  if (report.crossOrigin.length) console.log(`  ${report.crossOrigin.slice(0, 5).join('\n  ')}`);
  if (report.storageFindings.length) console.log(`  ${report.storageFindings.slice(0, 5).join('\n  ')}`);
  console.log(`report            : ${summaryPath}`);

  const failures =
    report.files.length -
    okFiles +
    report.consoleErrors.length +
    report.failedRequests.length +
    report.contentFailures.length;
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('HARNESS FAILED:', error);
  process.exit(1);
});