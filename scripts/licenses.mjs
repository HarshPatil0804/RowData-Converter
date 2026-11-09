#!/usr/bin/env node
/**
 * THIRD_PARTY_NOTICES.md – the licence record for everything shipped.
 *
 *   node scripts/licenses.mjs           # write the file
 *   node scripts/licenses.mjs --check   # fail when the file is out of date
 *
 * The list comes from `package-lock.json` (production dependencies, direct and
 * transitive), so it describes what `npm ci` installs rather than what happens
 * to be in one machine's `node_modules/`. Each entry carries name, version,
 * declared licence, the source URL and the full licence text; identical texts
 * are printed once and referenced, which keeps a 70-package file readable.
 *
 * The bundled assets that do not come from a package — the Tesseract worker,
 * the wasm cores, the English language data and the pdf.js worker — are listed
 * separately with their exact download source.
 *
 * Generation refuses to run when a dependency's licence is outside
 * `security/allowed-licenses.json`: a notices file must never be the first place
 * a licence problem is noticed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  POLICY_PATH,
  PACKAGE_SOURCE,
  hashOf,
  licenseText,
  productionPackages,
  readPolicy,
  resolvePackage,
} from './lib/licenses.mjs';

const OUT = 'THIRD_PARTY_NOTICES.md';
const check = process.argv.includes('--check');

const policy = readPolicy();
const packages = productionPackages().map((pkg) => resolvePackage(pkg, policy));

const rejected = packages.filter((pkg) => !pkg.allowed);
if (rejected.length > 0) {
  console.error('licenses: a production dependency is outside the allowlist');
  for (const pkg of rejected) {
    console.error(`  - ${pkg.name}@${pkg.version}: ${JSON.stringify(pkg.declaredRaw)} (see ${POLICY_PATH})`);
  }
  process.exit(1);
}

// ------------------------------------------------------------- assets ------

/** Files that are copied into public/ from a package or downloaded. */
function bundledAssets() {
  const asset = (name, file, license, source, note) => ({ name, file, license, source, note });
  const assets = [];
  const coreDir = 'public/tess';
  const coreFiles = ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'].filter((name) =>
    existsSync(join(coreDir, name)),
  );
  for (const file of coreFiles) {
    assets.push(
      asset(
        'Tesseract wasm core',
        `${coreDir}/${file}`,
        'Apache-2.0',
        'npm tesseract.js-core (copied by scripts/copy-ocr-assets.mjs)',
        'LSTM-only build, matching the OEM the app uses',
      ),
    );
  }
  if (existsSync(join(coreDir, 'worker.min.js'))) {
    assets.push(
      asset(
        'Tesseract worker',
        `${coreDir}/worker.min.js`,
        'Apache-2.0',
        'npm tesseract.js dist/worker.min.js (copied by scripts/copy-ocr-assets.mjs)',
        'Runs OCR inside a Web Worker',
      ),
    );
  }
  if (existsSync('public/tessdata/eng.traineddata.gz')) {
    assets.push(
      asset(
        'Tesseract English language data',
        'public/tessdata/eng.traineddata.gz',
        'Apache-2.0',
        'https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz (tesseract-ocr/tessdata_fast, 4.0.0_fast; fallbacks: https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_fast/eng.traineddata.gz and https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_fast/eng.traineddata.gz)',
        'Downloaded once by scripts/fetch-ocr-data.mjs; see that script for the exact URLs',
      ),
    );
  }
  // The worker file name carries a content hash that changes with every build,
  // so the row names the pattern rather than one build's file: the notices must
  // be identical whether or not dist/ happens to exist (CI checks them before
  // building).
  assets.push(
    asset(
      'pdf.js worker',
      'dist/assets/pdf.worker.min-<contenthash>.mjs',
      'Apache-2.0',
      'npm pdfjs-dist build/pdf.worker.min.mjs, bundled by Vite',
      'Renders PDF pages off the main thread',
    ),
  );
  return assets;
}

// ------------------------------------------------------------ document -----

const sections = [];
const texts = new Map(); // text hash → { id, license, text, from, packages[] }

function textId(pkg, chosen) {
  const resolved = licenseText(pkg, chosen);
  if (!resolved) {
    console.error(
      `licenses: ${pkg.name}@${pkg.version} ships no license file for ${chosen}; ` +
        `add scripts/license-texts/${chosen}.txt (canonical text) and re-run`,
    );
    process.exit(1);
  }
  const hash = hashOf(resolved.text);
  const existing = texts.get(hash);
  if (existing) {
    existing.packages.push(`${pkg.name}@${pkg.version}`);
    return existing.id;
  }
  const id = `T${texts.size + 1}`;
  texts.set(hash, {
    id,
    license: chosen,
    text: resolved.text,
    from: resolved.from,
    packages: [`${pkg.name}@${pkg.version}`],
  });
  return id;
}

sections.push('# Third-party notices');
sections.push('');
sections.push(
  'This file lists every third-party component shipped by this project, with its licence and the full',
  'licence text. It is generated — do not edit it by hand:',
  '',
  '```',
  'npm run licenses          # regenerate',
  'npm run licenses:check    # CI: fail when the tree, a licence or this file changed',
  '```',
  '',
  `The project itself is MIT licensed; see \`LICENSE\`. Licences are accepted only when they appear in`,
  `\`${POLICY_PATH}\` (${[...policy.allow].join(', ')}), and a change to that list is a reviewed edit of that file.`,
  '',
);

sections.push('## Dual-licensed packages');
sections.push('');
sections.push('These packages offer more than one licence. The licence this project uses is recorded here and applied');
sections.push('to the text below.');
sections.push('');
sections.push('| Package | Declared | Used here | Why |');
sections.push('| --- | --- | --- | --- |');
for (const [name, choice] of Object.entries(policy.choices)) {
  const pkg = packages.find((entry) => entry.name === name);
  sections.push(`| ${name} | \`${pkg?.declaredRaw ?? 'unknown'}\` | **${choice.license}** | ${choice.reason} |`);
}
sections.push('');

const overrides = Object.entries(policy.overrides);
if (overrides.length > 0) {
  sections.push('## Licence strings resolved by hand');
  sections.push('');
  sections.push('| Package | Declared | Read as | Why |');
  sections.push('| --- | --- | --- | --- |');
  for (const [name, override] of overrides) {
    const pkg = packages.find((entry) => entry.name === name);
    sections.push(`| ${name} | \`${pkg?.declaredRaw ?? 'unknown'}\` | **${override.license}** | ${override.reason} |`);
  }
  sections.push('');
}

sections.push(`## Production dependencies (${packages.length})`);
sections.push('');
sections.push('| Package | Version | Licence | Source | Text |');
sections.push('| --- | --- | --- | --- | --- |');
const rows = [];
for (const pkg of packages) {
  const id = textId(pkg, pkg.chosen);
  const source = PACKAGE_SOURCE(pkg.name, pkg);
  rows.push(`| \`${pkg.name}\` | ${pkg.version} | ${pkg.label} | ${source} | ${id} |`);
}
sections.push(...rows);
sections.push('');

sections.push('## Bundled assets');
sections.push('');
sections.push('| Asset | File | Licence | Source | Notes |');
sections.push('| --- | --- | --- | --- | --- |');
for (const entry of bundledAssets()) {
  sections.push(`| ${entry.name} | \`${entry.file}\` | ${entry.license} | ${entry.source} | ${entry.note} |`);
}
sections.push('');
sections.push(
  'The Tesseract worker and wasm cores are Apache-2.0, as is the `tesseract.js-core` package they come from.',
  'The English language data is the `tessdata_fast` 4.0.0 LSTM model, also Apache-2.0. The pdf.js worker is',
  'Apache-2.0 and is bundled from `pdfjs-dist`.',
  '',
);

sections.push('## Licence texts');
sections.push('');
for (const entry of texts.values()) {
  sections.push(`### ${entry.id} — ${entry.license}`);
  sections.push('');
  sections.push(`Text from ${entry.from}. Used by: ${entry.packages.join(', ')}.`);
  sections.push('');
  sections.push('```text');
  sections.push(entry.text);
  sections.push('```');
  sections.push('');
}

const document = `${sections.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== document) {
    console.error(`licenses: ${OUT} is out of date — run \`npm run licenses\` and commit the result`);
    process.exit(1);
  }
  console.log(
    `licenses: ${OUT} is up to date (${packages.length} packages, ${texts.size} licence texts, ` +
      `${bundledAssets().length} bundled assets)`,
  );
} else {
  writeFileSync(OUT, document);
  console.log(
    `licenses: wrote ${OUT} (${packages.length} packages, ${texts.size} licence texts, ` +
      `${bundledAssets().length} bundled assets, ${(document.length / 1024).toFixed(1)} kB)`,
  );
}
