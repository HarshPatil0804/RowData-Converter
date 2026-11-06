// @vitest-environment node
/**
 * Cleanup test — the promise that nothing is persisted, for the visitors who
 * were already here.
 *
 * The live build at 91ed3d7 installed a caching service worker and left it
 * behind. This test reproduces that state exactly (the fixture is that build's
 * sw.js, byte for byte), then loads the new build and requires the app to end
 * with **zero** service worker registrations and **zero** Cache Storage
 * entries — without the user pressing anything.
 *
 * Replaces tests/sw-update.test.ts, which asserted the opposite policy (a
 * worker that caches the shell, survives an offline reload and updates on one
 * reload). That policy is gone by charter, so the test that encoded it is gone;
 * this one keeps the protective guarantee that replaces it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, startDistServer, type DistServer } from './support/dist-server';
import type { Browser, BrowserContext, Page } from 'playwright-core';

const BUILT = fs.existsSync(path.resolve('dist/index.html'));
const describeCleanup = BUILT ? describe : describe.skip;
const LEGACY_WORKER = fs.readFileSync(path.resolve('tests/fixtures/sw-91ed3d7.js'), 'utf8');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Registrations and cache names as the page sees them. */
async function browserState(page: Page) {
  return page.evaluate(async () => ({
    registrations: (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope),
    caches: typeof caches === 'undefined' ? [] : await caches.keys(),
    localStorage: Object.keys(localStorage),
    sessionStorage: Object.keys(sessionStorage),
  }));
}

describeCleanup('a returning visitor is cleaned up without asking', () => {
  let server: DistServer | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  beforeAll(async () => {
    if (!BUILT) return;
    server = await startDistServer();
    browser = await launchBrowser();
    context = await browser.newContext();
    // The CSP under test requires a TrustedScriptURL for `register()`, so the
    // test mints one through the policy name the app allows. Nothing else in
    // this suite loads a page that constructs a Worker, so no clash.
    await context.addInitScript(() => {
      const host = (window as unknown as { trustedTypes?: { createPolicy: (name: string, rules: unknown) => unknown } })
        .trustedTypes;
      if (!host) return;
      try {
        (window as unknown as { __swPolicy?: unknown }).__swPolicy = host.createPolicy('u2s-worker', {
          createScriptURL: (value: string) => value,
        });
      } catch {
        // Already created by the page itself.
      }
    });
    page = await context.newPage();
  }, 120_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server?.close();
  }, 60_000);

  it('installs the live 91ed3d7 worker, then the new build removes it and its cache', async () => {
    const tab = page as Page;
    const dist = server as DistServer;

    // 1. The state a returning visitor is in: 91ed3d7's worker, installed and
    //    caching app assets.
    dist.override('/sw.js', LEGACY_WORKER);
    await tab.goto(dist.base, { waitUntil: 'domcontentloaded' });
    const installed = await tab.evaluate(async () => {
      const minted = (window as unknown as { __swPolicy?: { createScriptURL: (value: string) => string } }).__swPolicy;
      const url = minted ? minted.createScriptURL('./sw.js') : './sw.js';
      await navigator.serviceWorker.register(url);
      await navigator.serviceWorker.ready;
      // The old worker precaches on install; give it a moment to finish.
      for (let i = 0; i < 40; i += 1) {
        if ((await caches.keys()).length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return {
        registrations: (await navigator.serviceWorker.getRegistrations()).length,
        caches: await caches.keys(),
      };
    });
    expect(installed.registrations, 'the legacy worker should be installed for this test to mean anything').toBe(1);
    expect(installed.caches.length, 'the legacy worker should have cached something').toBeGreaterThan(0);

    // 2. The new build is served (its /sw.js is the tombstone) and loaded.
    dist.clearOverride('/sw.js');
    await tab.goto(dist.base, { waitUntil: 'domcontentloaded' });

    // 3. No user action: registrations and caches must go to zero.
    const started = Date.now();
    let state = await browserState(tab);
    while ((state.registrations.length > 0 || state.caches.length > 0) && Date.now() - started < 60_000) {
      await sleep(250);
      state = await browserState(tab);
    }

    expect(state, `after ${Date.now() - started} ms`).toEqual({
      registrations: [],
      caches: [],
      localStorage: [],
      sessionStorage: [],
    });
  }, 180_000);
});
