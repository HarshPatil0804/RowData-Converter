#!/usr/bin/env node
/**
 * Documentation screenshots + social card, captured from the live site.
 *
 *   node e2e/screens.mjs --base-url <url>
 *
 * Writes docs/screens/*.png (desktop + 390 px mobile) and public/og.png
 * (exactly 1200×630, the size declared in index.html's og:image tags).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

const BASE_URL = arg('base-url', 'https://row-data-converter.vercel.app');
const SAMPLE = path.resolve(arg('sample', 'samples/dev/messy_sales.csv'));
const SHOTS = path.resolve('docs/screens');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync('public', { recursive: true });

async function ready(tab) {
  await tab.getByText('Your data is ready').waitFor({ timeout: 300_000 });
  await tab.waitForTimeout(400);
}

async function shoot(tab, file, opts = {}) {
  await tab.screenshot({ path: file, ...opts });
  console.log(`saved ${file}`);
}

async function load(tab) {
  await tab.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await tab.setInputFiles('input[type=file]', SAMPLE);
  await ready(tab);
}

async function main() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  } catch {
    browser = await chromium.launch({ headless: true });
  }

  try {
    // ---- desktop -----------------------------------------------------------
    const desktop = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const tab = await desktop.newPage();
    await tab.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await shoot(tab, path.join(SHOTS, '01-upload-desktop.png'));

    await load(tab);
    await shoot(tab, path.join(SHOTS, '02-preview-desktop.png'));

    await tab.getByRole('button', { name: 'Tabular', exact: false }).first().click();
    await tab.waitForTimeout(300);
    await shoot(tab, path.join(SHOTS, '03-tabular-desktop.png'));

    const review = tab.getByRole('button', { name: 'Needs review', exact: false }).first();
    if (await review.isVisible().catch(() => false)) {
      await review.click();
      await tab.waitForTimeout(300);
      await shoot(tab, path.join(SHOTS, '04-needs-review-desktop.png'));
    }

    await tab.getByRole('button', { name: 'Pivot table', exact: false }).first().click();
    await tab.waitForTimeout(400);
    await shoot(tab, path.join(SHOTS, '05-pivot-desktop.png'));

    await tab.getByRole('button', { name: 'Tabular', exact: false }).first().click();
    await tab.getByLabel('Toggle dark mode').click();
    await tab.waitForTimeout(300);
    await shoot(tab, path.join(SHOTS, '06-tabular-dark-desktop.png'));
    await tab.getByLabel('Toggle dark mode').click();

    // ---- social card: exactly 1200×630 ------------------------------------
    const card = await browser.newContext({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1,
    });
    const cardTab = await card.newPage();
    await load(cardTab);
    await cardTab.getByRole('button', { name: 'Tabular', exact: false }).first().click();
    await cardTab.waitForTimeout(400);
    await shoot(cardTab, path.resolve('public/og.png'));
    await card.close();

    // ---- mobile 390 px -----------------------------------------------------
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const mobileTab = await mobile.newPage();
    await mobileTab.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await shoot(mobileTab, path.join(SHOTS, '07-upload-mobile.png'));
    await load(mobileTab);
    await shoot(mobileTab, path.join(SHOTS, '08-preview-mobile.png'));
    await mobileTab.getByRole('button', { name: 'Tabular', exact: false }).first().click();
    await mobileTab.waitForTimeout(300);
    await shoot(mobileTab, path.join(SHOTS, '09-tabular-mobile.png'));
    await mobile.close();

    await desktop.close();
  } finally {
    await browser.close();
  }

  const png = fs.readFileSync(path.resolve('public/og.png'));
  // PNG IHDR: width/height are big-endian uint32 at bytes 16..23.
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  console.log(`og.png is ${width}×${height}`);
  if (width !== 1200 || height !== 630) {
    throw new Error(`og.png must be 1200×630, got ${width}×${height}`);
  }
}

main().catch((error) => {
  console.error('HARNESS FAILED:', error);
  process.exit(1);
});
