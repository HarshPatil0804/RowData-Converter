// @vitest-environment node
/**
 * Service-worker safety, proven rather than asserted.
 *
 * The worker is deliberately narrow (see public/sw.js): navigations are network
 * first so a deploy lands on the next reload, /version.json is never
 * intercepted, only content-hashed/versioned asset paths are cached, and no
 * non-http(s) request is touched.
 *
 * This test serves a real build from a local HTTP server and checks:
 *   - the SW activates and the app shell renders from cache when the network
 *     dies (so the cache is genuinely used);
 *   - after the served build is swapped for another one, a single reload shows
 *     the new build hash (no stale shell);
 *   - nothing but app assets is stored in the Cache API.
 */
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const BUILT = fs.existsSync(path.join(DIST, 'index.html'));
const TMP = path.join(ROOT, 'e2e-out', 'sw');
const PORT = 4328;
const BASE = `http://localhost:${PORT}`;
const NEW_HASH = 'beefbee';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.woff2': 'font/woff2',
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/** Copy dist/ to a directory that represents one deployed build. */
function stageBuild(name: string, patch?: { hash: string }): string {
  const target = path.join(TMP, name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(DIST, target, { recursive: true });
  if (patch) {
    const htmlPath = path.join(target, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8').replace(
      /<meta name="build" content="[^"]*">/,
      `<meta name="build" content="${patch.hash}">`,
    );
    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(path.join(target, 'version.json'), `${JSON.stringify({ hash: patch.hash, builtAt: 'test' })}\n`);
  }
  return target;
}

const buildHash = fs.existsSync(path.join(DIST, 'version.json'))
  ? JSON.parse(fs.readFileSync(path.join(DIST, 'version.json'), 'utf8')).hash
  : 'unknown';

let serveRoot = '';
let offline = false;
let server: http.Server | null = null;
let browser: Browser | null = null;
let page: Page | null = null;

function handler(request: http.IncomingMessage, response: http.ServerResponse): void {
  if (offline) {
    // A dead connection, not an error response: fetch() rejects, so the SW's
    // offline fallback is what must answer.
    request.socket.destroy();
    return;
  }
  const url = new URL(request.url ?? '/', BASE);
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.join(serveRoot, pathname);
  if (!file.startsWith(serveRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(response);
}

async function shellHash(tab: Page): Promise<string | null> {
  return tab.evaluate(() => document.querySelector('meta[name="build"]')?.getAttribute('content') ?? null);
}

const describeSw = BUILT ? describe : describe.skip;

describeSw('service worker: updates, offline fallback, no user data', () => {
  beforeAll(async () => {
    if (!BUILT) return;
    fs.mkdirSync(TMP, { recursive: true });
    serveRoot = stageBuild('a');
    expect(await portFree(PORT)).toBe(true);
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server?.listen(PORT, '127.0.0.1', resolve));
    try {
      browser = await chromium.launch({ headless: true, channel: 'chrome' });
    } catch {
      browser = await chromium.launch({ headless: true });
    }
    const context = await browser.newContext();
    page = await context.newPage();
  }, 120_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    fs.rmSync(TMP, { recursive: true, force: true });
  }, 60_000);

  it('caches the shell, survives an offline reload, and updates on one reload', async () => {
    const tab = page as Page;

    await tab.goto(BASE, { waitUntil: 'load' });
    expect(await shellHash(tab)).toBe(buildHash);

    // The worker registers on window load and takes control on activate.
    await tab.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    for (let i = 0; i < 40; i += 1) {
      const controlled = await tab.evaluate(() => navigator.serviceWorker.controller !== null);
      if (controlled) break;
      await sleep(100);
    }
    expect(await tab.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    // Cache contents: app assets only, never blob:/data: or user files.
    const cached = await tab.evaluate(async () => {
      const out: string[] = [];
      for (const key of await caches.keys()) {
        for (const request of await (await caches.open(key)).keys()) out.push(request.url);
      }
      return out;
    });
    expect(cached.length).toBeGreaterThan(0);
    for (const url of cached) {
      expect(url, `unexpected cache entry ${url}`).toMatch(
        /\/(assets|tess|tessdata)\/[^/]+$|^https?:\/\/[^/]+\/$/,
      );
    }
    expect(cached.some((url) => /^(blob|data):/.test(url))).toBe(false);

    // --- offline: the shell must still render, from cache -----------------
    offline = true;
    await tab.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await sleep(500);
    expect(await tab.evaluate(() => document.body.innerText.includes('Unstructured'))).toBe(true);
    offline = false;

    // --- new deploy: one reload must show the new build -------------------
    serveRoot = stageBuild('b', { hash: NEW_HASH });
    await tab.reload({ waitUntil: 'load' });
    expect(await shellHash(tab)).toBe(NEW_HASH);
    const liveVersion = await tab.evaluate(async () => (await fetch('/version.json', { cache: 'no-store' })).json());
    expect(liveVersion.hash).toBe(NEW_HASH);
  }, 180_000);
});
