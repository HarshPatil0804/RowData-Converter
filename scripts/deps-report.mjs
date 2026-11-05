#!/usr/bin/env node
/**
 * The production dependency inventory, and the gate that keeps it honest.
 *
 * Task: every runtime dependency must be a deliberate, reviewed choice. So:
 *   - `security/allowed-deps.json` lists the full production tree (direct and
 *     transitive, with versions) and every package that runs an install script;
 *   - `node scripts/deps-report.mjs` prints the report (versions, install
 *     scripts, transitive count, unused direct dependencies);
 *   - `node scripts/deps-report.mjs --check` fails when the installed tree
 *     differs from the reviewed file, which is what CI runs.
 *
 * A dependency update therefore cannot land silently: Dependabot opens a PR,
 * CI fails until someone regenerates the file with `npm run deps:record` and
 * reads the diff. Removing a package also shows up as a diff.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const LOCK = 'package-lock.json';
const PKG = 'package.json';
const ALLOWED = 'security/allowed-deps.json';
const check = process.argv.includes('--check');

if (!existsSync(LOCK)) {
  console.error('deps-report: package-lock.json is missing; run npm install first.');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
const locked = lock.packages ?? {};

/** Every package that is installed at runtime (not dev-only, not the root). */
const prod = new Map();
for (const [key, entry] of Object.entries(locked)) {
  if (key === '') continue;
  if (entry.dev === true || entry.devOptional === true) continue;
  if (entry.link) continue;
  const name = entry.name ?? key.replace(/^.*node_modules\//, '');
  prod.set(name, { version: entry.version ?? 'unknown', key, scripts: entry.hasInstallScript === true });
}

const direct = Object.keys(pkg.dependencies ?? {}).sort();
const dev = Object.keys(pkg.devDependencies ?? {}).sort();

/** Files that may import a runtime dependency. */
function sources(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|js|mjs|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const sourceText = [...sources('src'), ...sources('scripts'), ...sources('tests')]
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

/** A direct dependency is "used" if some file imports it by name. */
function isUsed(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(from\\s*['"]${escaped}|require\\(['"]${escaped}|import\\s+['"]${escaped})`).test(sourceText);
}

/**
 * Packages that declare an install/preinstall/postinstall script, read from the
 * installed package.json (the lockfile only carries the flag for some versions).
 */
function installScriptsOf(name) {
  const file = join('node_modules', name, 'package.json');
  if (!existsSync(file)) return [];
  const manifest = JSON.parse(readFileSync(join('node_modules', name, 'package.json'), 'utf8'));
  return ['preinstall', 'install', 'postinstall']
    .filter((hook) => typeof manifest.scripts?.[hook] === 'string')
    .map((hook) => `${hook}: ${manifest.scripts[hook]}`);
}

const inventory = Object.fromEntries(
  [...prod.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, entry]) => [name, entry.version]),
);
const scripts = {};
for (const name of Object.keys(inventory)) {
  const hooks = installScriptsOf(name);
  if (hooks.length) scripts[name] = hooks;
}

const unused = direct.filter((name) => !isUsed(name));

const allowed = existsSync(ALLOWED) ? JSON.parse(readFileSync(ALLOWED, 'utf8')) : null;

if (!check) {
  console.log(`Production dependencies: ${prod.size} packages installed (${direct.length} direct, ${prod.size - direct.length} transitive).\n`);
  for (const name of direct) {
    console.log(`  ${name}@${inventory[name] ?? '?'}${isUsed(name) ? '' : '   <-- NOT IMPORTED'}`);
  }
  console.log('\nRuntime packages with install scripts:');
  if (!Object.keys(scripts).length) console.log('  none');
  for (const [name, hooks] of Object.entries(scripts)) console.log(`  ${name}: ${hooks.join(' | ')}`);
  if (unused.length) {
    console.log(`\nDirect dependencies that no source file imports: ${unused.join(', ')}`);
  } else {
    console.log('\nEvery direct dependency is imported somewhere.');
  }
}

const problems = [];
if (check) {
  if (!allowed) {
    problems.push(`${ALLOWED} is missing; run npm run deps:record`);
  } else {
    for (const [name, entry] of Object.entries(allowed.inventory ?? {})) {
      if (!inventory[name]) problems.push(`${name}@${entry} is allowed but no longer installed`);
      else if (inventory[name] !== entry) {
        problems.push(`${name}: installed ${inventory[name]}, reviewed ${entry}`);
      }
    }
    for (const [name, version] of Object.entries(inventory)) {
      if (!allowed.inventory?.[name]) problems.push(`${name}@${version} is not in ${ALLOWED}`);
    }
    for (const name of direct) {
      if (!allowed.direct?.includes(name)) problems.push(`${name} is a direct dependency but is not listed as one`);
    }
    for (const name of allowed.direct ?? []) {
      if (!direct.includes(name)) problems.push(`${name} is listed as direct but package.json does not list it`);
    }
    for (const name of allowed.dev ?? []) {
      if (!dev.includes(name)) problems.push(`${name} is listed as a dev dependency but package.json does not list it`);
    }
    for (const name of dev) {
      if (!allowed.dev?.includes(name)) problems.push(`${name} is a dev dependency but is not listed as one`);
    }
    const allowedScripts = allowed.installScripts ?? {};
    for (const [name, hooks] of Object.entries(scripts)) {
      if (JSON.stringify(allowedScripts[name]) !== JSON.stringify(hooks)) {
        problems.push(`${name}: install scripts ${JSON.stringify(hooks)} differ from the reviewed ${JSON.stringify(allowedScripts[name] ?? null)}`);
      }
    }
    for (const name of Object.keys(allowedScripts)) {
      if (!scripts[name]) problems.push(`${name}: reviewed install scripts are gone`);
    }
  }
}

if (check && problems.length) {
  console.error(`deps-report: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  console.error('\nReview the change. If it is intended, run `npm run deps:record` and commit the diff.');
  process.exit(1);
}

if (check) console.log(`deps-report: OK — ${prod.size} production packages match ${ALLOWED}.`);

const record = process.argv.includes('--record');
if (record) {
  const previous = allowed ?? {};
  const next = {
    note: 'Reviewed production dependency inventory. Regenerate with `npm run deps:record`; CI fails when the installed tree differs.',
    generatedAt: previous.generatedAt ?? null,
    direct,
    dev,
    inventory,
    installScripts: scripts,
    transitive: prod.size - direct.length,
    sourceFiles: [...new Set([...sources('src')])].length,
    lockfile: relative(process.cwd(), LOCK).split('\\').join('/'),
    lockfileVersion: lock.lockfileVersion,
  };
  // generatedAt is deliberately not refreshed: a timestamp here would make the
  // file change on every regeneration even when nothing else did.
  next.generatedAt = previous.generatedAt ?? new Date().toISOString().slice(0, 10);
  writeFileSync(ALLOWED, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`deps-report: wrote ${ALLOWED} (${prod.size} packages)`);
}

void statSync;
