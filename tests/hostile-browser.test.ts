// @vitest-environment node
/**
 * Hostile corpus, browser side — against the production build with the real
 * CSP from vercel.json.
 *
 * For every hostile file the page must prove, in a real browser:
 *   - no script ran: a window canary flag stays false;
 *   - no CSP violation was reported;
 *   - no request went to another origin;
 *   - no main-thread task took longer than 1 s;
 *   - the UI answered: a result or a readable refusal, never a hang.
 *
 * One test per file, so a failure names the file and a green run shows every
 * outcome as it happens instead of one line at the end.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, startDistServer, type DistServer } from './support/dist-server';
import { LIMITS } from '../src/pipeline/limits';
import type { Browser, BrowserContext, Page } from 'playwright-core';

const DIR = path.resolve('tests/hostile');
const BUILT = fs.existsSync(path.resolve('dist/index.html'));
const describeHostile = BUILT ? describe : describe.skip;
const LONG_TASK_BUDGET_MS = 1000;
const FILE_TIMEOUT_MS = 120_000;

const files = fs.existsSync(DIR)
  ? fs
      .readdirSync(DIR)
      .filter((name) => fs.statSync(path.join(DIR, name)).isFile())
      .sort()
  : [];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const CANARY = () => {
  // Runs before any page script: the flag a successful XSS would flip.
  (window as unknown as { __pwned: boolean }).__pwned = false;
  (window as unknown as { __csp: string[] }).__csp = [];
  (window as unknown as { __longTasks: number[] }).__longTasks = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    const entry = `${event.violatedDirective} ${event.blockedURI}`;
    (window as unknown as { __csp: string[] }).__csp.push(entry);
  });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        (window as unknown as { __longTasks: number[] }).__longTasks.push(Math.round(entry.duration));
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    // longtask unsupported
  }
};

/**
 * Wait for the app's own verdict. The refusal must come from the alert region:
 * the landing page's own copy mentions limits, so matching free text would
 * "pass" before the file was even read.
 */
async function outcome(tab: Page, timeoutMs = FILE_TIMEOUT_MS): Promise<'ready' | 'refused'> {
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

describeHostile('hostile corpus in the deployed build', () => {
  let server: DistServer | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let tab: Page | null = null;

  beforeAll(async () => {
    if (!BUILT) return;
    server = await startDistServer();
    browser = await launchBrowser();
    context = await browser.newContext({ acceptDownloads: true });
    await context.addInitScript(CANARY);
    tab = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server?.close();
  }, 60_000);

  it('has a corpus to test', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  for (const name of files) {
    it(`${name}: no script, no CSP violation, no outgoing request, no frozen UI`, async () => {
      const page = tab as Page;
      const base = (server as DistServer).base;

      const external: string[] = [];
      const onRequest = (request: { url(): string }) => {
        const url = request.url();
        if (!url.startsWith(base) && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
      };
      page.on('request', onRequest);

      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        (window as unknown as { __longTasks: number[] }).__longTasks = [];
        (window as unknown as { __csp: string[] }).__csp = [];
      });

      const before = Date.now();
      await page.setInputFiles('input[type=file]', path.join(DIR, name));
      let result: 'ready' | 'refused' | 'threw' = 'threw';
      let detail = '';
      try {
        result = await outcome(page);
      } catch (error) {
        detail = (error as Error).message;
      }
      const elapsed = Date.now() - before;

      // Give late timers a moment: an injected payload that runs on a timeout
      // would fire here rather than during the upload.
      await sleep(150);

      const state = await page.evaluate(() => ({
        pwned: (window as unknown as { __pwned: boolean }).__pwned,
        csp: (window as unknown as { __csp: string[] }).__csp,
        tasks: (window as unknown as { __longTasks: number[] }).__longTasks,
        heap: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
        responsive: document.body.innerText.length > 0,
      }));

      page.off('request', onRequest);

      const failures: string[] = [];
      if (state.pwned) failures.push('SCRIPT RAN (canary set)');
      if (state.csp.length) failures.push(`CSP violations ${state.csp.slice(0, 3).join(' | ')}`);
      if (external.length) failures.push(`external requests ${external.slice(0, 3).join(' | ')}`);
      if (!state.responsive) failures.push('page rendered nothing');
      const longest = state.tasks.length ? Math.max(...state.tasks) : 0;
      if (longest > LONG_TASK_BUDGET_MS) failures.push(`main-thread task ${longest} ms`);
      if (state.heap > 1_500 * 1024 * 1024) failures.push(`heap ${Math.round(state.heap / 1048576)} MB`);
      if (result === 'threw') failures.push(`no result and no message: ${detail}`);

      // The outcome is part of the assertion text so a green run is auditable.
      expect(failures, `${name}: ${result} in ${elapsed} ms, long tasks=${JSON.stringify(state.tasks)}`).toEqual([]);
      expect(['ready', 'refused']).toContain(result);
    }, FILE_TIMEOUT_MS + 60_000);
  }

  it('documents the upload limit the code enforces', async () => {
    // The limit is enforced twice (UI and pipeline); assert the number the
    // README documents is the one the code uses.
    expect(LIMITS.inputBytes).toBe(200 * 1024 * 1024);
  });
});
