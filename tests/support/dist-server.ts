// @vitest-environment node
/**
 * Serve the production build the way Vercel does: the same files, the same
 * `vercel.json` headers (including CSP), the same SPA fallback.
 *
 * Tests use this instead of `vite preview` when the header policy matters —
 * CSP violations and Trusted Types cannot be reproduced by preview.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const DIST = path.resolve('dist');

/**
 * Match a vercel.json `source` the way Vercel's path matcher does for the
 * patterns used here: an exact path, a regex (anything with `(` or `.*`), or a
 * directory prefix.
 */
function matchesSource(source: string, pathname: string): boolean {
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

/** Headers for a path, from vercel.json: exact sources first, then patterns. */
function headersFor(pathname: string): Record<string, string> {
  const config = JSON.parse(fs.readFileSync(path.resolve('vercel.json'), 'utf8')) as {
    headers?: { source: string; headers: { key: string; value: string }[] }[];
  };
  const out: Record<string, string> = {};
  for (const entry of config.headers ?? []) {
    if (!matchesSource(entry.source, pathname)) continue;
    for (const header of entry.headers) out[header.key] = header.value;
  }
  return out;
}

export interface DistServer {
  base: string;
  port: number;
  close(): Promise<void>;
  setOffline(value: boolean): void;
  /** Serve a different body for one path, e.g. an older build's /sw.js. */
  override(pathname: string, body: string): void;
  clearOverride(pathname: string): void;
  /** Requests that reached the server, for "did anything leave the page" checks. */
  requests: { method: string; url: string }[];
}

export async function startDistServer(requestedPort = 0): Promise<DistServer> {
  const requests: DistServer['requests'] = [];
  const overrides = new Map<string, string>();
  let offline = false;

  const server = http.createServer((request, response) => {
    requests.push({ method: request.method ?? 'GET', url: request.url ?? '/' });
    if (offline) {
      request.socket.destroy();
      return;
    }
    const pathname = new URL(request.url ?? '/', `http://localhost:${port}`).pathname;
    const replacement = overrides.get(pathname);
    if (replacement !== undefined) {
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        ...headersFor(pathname),
      });
      response.end(replacement);
      return;
    }
    let file = path.join(DIST, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // SPA fallback, exactly like the vercel rewrite.
      file = path.join(DIST, 'index.html');
    }
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      ...headersFor(pathname),
    });
    fs.createReadStream(file).pipe(response);
  });

  await new Promise<void>((resolve) => server.listen(requestedPort, '127.0.0.1', resolve));
  // Port 0 asks the OS for a free port: two suites can run at once, and a
  // leftover server from an interrupted run cannot break the next one.
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://localhost:${port}`,
    port,
    requests,
    setOffline(value: boolean) {
      offline = value;
    },
    override(pathname: string, body: string) {
      overrides.set(pathname, body);
    },
    clearOverride(pathname: string) {
      overrides.delete(pathname);
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Chrome if the machine has it, else the bundled browser. */
export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, channel: 'chrome' });
  } catch {
    return await chromium.launch({ headless: true });
  }
}
