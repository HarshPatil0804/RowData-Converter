#!/usr/bin/env node
/**
 * One-file diagnostic: upload a file, then print the page's visible text and
 * console output for a few seconds so a stuck conversion shows *where* it is.
 *
 *   node e2e/probe.mjs --base-url <url> --file <path> [--wait 20000]
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import process from 'node:process';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const BASE_URL = arg('base-url', 'https://row-data-converter.vercel.app');
const FILE = path.resolve(arg('file', 'samples/dev/meeting_notes.docx'));
const WAIT = Number(arg('wait', '20000'));

const browser = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() =>
  chromium.launch({ headless: true }),
);
const context = await browser.newContext();
const tab = await context.newPage();
tab.on('console', (message) => console.log(`[console.${message.type()}] ${message.text()}`));
tab.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
tab.on('worker', (worker) => {
  console.log(`[worker created] ${worker.url()}`);
  worker.on('close', () => console.log('[worker closed]'));
});
tab.on('requestfailed', (request) =>
  console.log(`[requestfailed] ${request.url()} ${request.failure()?.errorText}`),
);

await tab.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
await tab.setInputFiles('input[type=file]', FILE);
const started = Date.now();
for (let elapsed = 0; elapsed <= WAIT; elapsed += 2000) {
  await tab.waitForTimeout(2000);
  const state = await tab.evaluate(() => {
    const body = document.body.innerText.replace(/\s+/g, ' ').trim();
    const ready = body.includes('Your data is ready');
    const errorAt = body.search(/could not be|Could not|failed|Failed/i);
    const text = errorAt >= 0 ? body.slice(errorAt, errorAt + 500) : body.slice(0, 400);
    return { ready, text };
  });
  console.log(`t+${Math.round((Date.now() - started) / 1000)}s ready=${state.ready} :: ${state.text}`);
  if (state.ready) break;
}

await browser.close();
