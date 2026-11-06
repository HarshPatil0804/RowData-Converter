#!/usr/bin/env node
/**
 * Task A — what does a full session leave in the browser?
 *
 * Loads a build, converts a sample, opens the tabular view, flips its toggles,
 * downloads CSV, then clears data, and prints everything the origin holds:
 * cookies, localStorage, sessionStorage, IndexedDB, Cache Storage, service
 * worker registrations and OPFS. Output is JSON so it can be diffed.
 *
 * Usage: node scripts/inventory.mjs [url] [--keep] [--assert-empty]
 *   (default url: http://localhost:4332, serving dist/ with vercel headers)
 *   --keep          stop before "Clear data" (to show what a session leaves behind)
 *   --assert-empty  exit 1 unless every store is empty (this is what CI runs)
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const assertEmpty = args.includes('--assert-empty');
const urlArg = args.find((arg) => arg.startsWith('http'));
const DIST = path.resolve('dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function matchesSource(source, pathname) {
  if (source === pathname) return true;
  if (source.includes('(') || source.includes('.*')) {
    try {
      return new RegExp(`^${source}$`).test(pathname);
    } catch {
      return false;
    }
  }
  return pathname.startsWith(source.endsWith('/') ? source : `${source}/`);
}

function headersFor(pathname) {
  const config = JSON.parse(fs.readFileSync(path.resolve('vercel.json'), 'utf8'));
  const out = {};
  for (const entry of config.headers ?? []) {
    if (!matchesSource(entry.source, pathname)) continue;
    for (const header of entry.headers) out[header.key] = header.value;
  }
  return out;
}

let server = null;
let base = urlArg;
if (!base) {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    let file = path.join(DIST, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      ...headersFor(pathname),
    });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(4332, '127.0.0.1', resolve));
  base = 'http://localhost:4332';
}

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const consoleLines = [];
page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
page.on('pageerror', (error) => consoleLines.push(`pageerror: ${error.message}`));

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.setInputFiles('input[type=file]', path.resolve('samples/dev/messy_sales.csv'));
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('h2')).some((h) => (h.textContent ?? '').includes('Your data is ready')),
  undefined,
  { timeout: 120_000 },
);

// Open the tabular view and flip its export toggles, so preference writes (if
// any) would happen here.
const tabular = page.getByRole('button', { name: 'Tabular', exact: false }).first();
if (await tabular.count()) await tabular.click();
const toggle = page.getByLabel('Spreadsheet-safe export');
if (await toggle.count()) await toggle.click();
const explode = page.getByLabel('Explode multi-item rows');
if (await explode.count()) await explode.click();

const download = page.getByRole('button', { name: 'Download CSV' }).first();
if (await download.count()) {
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  await file.path();
}

if (!keep) {
  await page.getByRole('button', { name: /Clear data/ }).first().click();
  await page.waitForTimeout(500);
}

const inventory = await page.evaluate(async () => {
  const safe = async (name, run) => {
    try {
      return { name, value: await run() };
    } catch (error) {
      return { name, error: String(error) };
    }
  };
  const local = await safe('localStorage', () => Object.fromEntries(Object.entries(localStorage)));
  const session = await safe('sessionStorage', () => Object.fromEntries(Object.entries(sessionStorage)));
  const dbs = await safe('indexedDB', async () => (indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name) : 'unsupported'));
  const cacheKeys = await safe('caches', () => (typeof caches === 'undefined' ? 'unsupported' : caches.keys()));
  const sw = await safe('serviceWorkers', async () =>
    'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope) : 'unsupported',
  );
  const opfs = await safe('opfs', async () => {
    if (!navigator.storage?.getDirectory) return 'unsupported';
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const [name] of root.entries()) names.push(name);
    return names;
  });
  return {
    url: location.href,
    title: document.title,
    cookies: document.cookie,
    localStorage: local,
    sessionStorage: session,
    indexedDB: dbs,
    caches: cacheKeys,
    serviceWorkers: sw,
    opfs,
  };
});

const cookies = await context.cookies();
console.log(
  JSON.stringify(
    { base, keptSession: keep, cookies, consoleLines, page: inventory },
    null,
    2,
  ),
);

if (assertEmpty) {
  const value = (entry) => entry.value ?? entry.error;
  const isEmpty = (entry) => {
    const held = value(entry);
    return held === 'unsupported' || (held && typeof held === 'object' ? Object.keys(held).length === 0 : !held);
  };
  const failures = [];
  if (cookies.length > 0) failures.push(`cookies: ${cookies.length}`);
  for (const entry of [inventory.localStorage, inventory.sessionStorage, inventory.indexedDB, inventory.caches, inventory.serviceWorkers, inventory.opfs]) {
    if (!isEmpty(entry)) failures.push(`${entry.name}: ${JSON.stringify(value(entry))}`);
  }
  if (failures.length > 0) {
    console.error(`FAIL: a session left data behind:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('EMPTY: no cookies, localStorage, sessionStorage, IndexedDB, caches, workers or OPFS files');
  }
}

await context.close();
await browser.close();
if (server) server.close();
