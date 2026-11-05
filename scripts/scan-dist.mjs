#!/usr/bin/env node
/**
 * Scan the built bundle for anything that could talk to the network.
 *
 * The privacy claim is "nothing is uploaded". A bundled dependency can quietly
 * break that promise with one `fetch("https://…/telemetry")`, and no unit test
 * would notice. So every build is scanned for:
 *
 *   1. every `http(s)://` origin in the shipped text; and
 *   2. every network call token: fetch(, XMLHttpRequest, sendBeacon,
 *      new WebSocket, EventSource.
 *
 * Both are compared with security/dist-baseline.json, which records an
 * allow-listed set of origins (XML namespace URIs are strings, not requests)
 * and per-file call counts with a written reason. A new origin, a new call
 * site, or more calls than were reviewed fails the build, and a human has to
 * either remove it or record why it is safe.
 *
 * Counts are compared per logical file: content hashes are stripped from the
 * name, so an unrelated code change does not churn the baseline, while a
 * dependency update that adds a call site does.
 *
 * Usage:
 *   node scripts/scan-dist.mjs            # check (exit 1 on an unexpected find)
 *   node scripts/scan-dist.mjs --update   # rewrite the baseline numbers
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DIST = 'dist';
const BASELINE_PATH = 'security/dist-baseline.json';
const TOKENS = ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'new WebSocket', 'EventSource'];
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.json', '.css', '.txt']);
// version.json and integrity.json change on every build by design; nothing is
// executed from them.
const SKIP = new Set(['version.json', 'integrity.json']);

const update = process.argv.includes('--update');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** `assets/index-6OelSUZg.js` → `assets/index.js`, so hashes do not churn. */
function logicalName(key) {
  return key.replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/, '$1');
}

const DOMAIN = /https?:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%-]+/g;

function scan() {
  const domains = new Map();
  const calls = new Map();
  const scanErrors = [];

  for (const file of walk(DIST)) {
    const key = relative(DIST, file).split(sep).join('/');
    if (SKIP.has(key)) continue;
    const extension = key.slice(key.lastIndexOf('.'));
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes('\u0000')) {
      scanErrors.push(`${key}: looks binary but is shipped as ${extension}`);
      continue;
    }
    for (const match of text.match(DOMAIN) ?? []) {
      const origin = match.replace(/^(https?:\/\/[^/]+).*$/, '$1');
      const entry = domains.get(origin) ?? { count: 0, files: new Set() };
      entry.count += 1;
      entry.files.add(logicalName(key));
      domains.set(origin, entry);
    }
    const logical = logicalName(key);
    for (const token of TOKENS) {
      let count = 0;
      for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + token.length)) count += 1;
      if (count === 0) continue;
      const perFile = calls.get(logical) ?? {};
      perFile[token] = count;
      calls.set(logical, perFile);
    }
  }

  return { domains, calls, scanErrors };
}

const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  : { version: 1, domains: {}, calls: {} };

const { domains, calls, scanErrors } = scan();
const problems = [...scanErrors];
const lines = [];

lines.push(`scan-dist: ${domains.size} origin(s), ${[...calls.values()].reduce((n, per) => n + Object.values(per).reduce((a, b) => a + b, 0), 0)} network call token(s) in ${DIST}/`);

for (const [origin, entry] of [...domains.entries()].sort()) {
  const known = baseline.domains?.[origin];
  if (!known) {
    problems.push(`${origin} (${entry.count}× in ${[...entry.files].join(', ')}): not in ${BASELINE_PATH}`);
  } else if (/^UNREVIEWED/.test(known)) {
    problems.push(`${origin}: allow-listed but not reviewed — write the reason in ${BASELINE_PATH}`);
  }
  lines.push(`  ${origin}${known ? '' : '  <-- NEW'} — ${known ?? 'no justification'}`);
}

for (const [file, perFile] of [...calls.entries()].sort()) {
  const reason = baseline.callReasons?.[file];
  if (!reason) problems.push(`${file}: network calls are not justified in ${BASELINE_PATH} (callReasons)`);
  else if (/^UNREVIEWED/.test(reason)) problems.push(`${file}: call reason is still UNREVIEWED`);
  for (const [token, count] of Object.entries(perFile).sort()) {
    const allowed = baseline.calls?.[file]?.[token];
    if (typeof allowed !== 'number') {
      problems.push(`${file}: ${token} ×${count} is not in ${BASELINE_PATH}`);
    } else if (count > allowed) {
      problems.push(`${file}: ${token} ×${count} exceeds the reviewed ${allowed}`);
    }
    lines.push(`  ${file}: ${token} ×${count}${typeof allowed === 'number' ? '' : '  <-- NEW'}`);
  }
}

if (update) {
  const next = {
    version: 1,
    generatedBy: 'node scripts/scan-dist.mjs --update',
    domains: Object.fromEntries(
      [...domains.entries()].sort().map(([origin, entry]) => [
        origin,
        baseline.domains?.[origin] ?? `UNREVIEWED (${entry.count}× in ${[...entry.files].join(', ')}) — confirm it is a namespace/string, not a request`,
      ]),
    ),
    calls: {},
  };
  // Written reasons for call sites are kept; the counts are refreshed.
  next.calls = Object.fromEntries(
    [...calls.entries()].sort().map(([file, perFile]) => [file, Object.fromEntries(Object.entries(perFile).sort())]),
  );
  next.callReasons = baseline.callReasons ?? {};
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`scan-dist: baseline rewritten at ${BASELINE_PATH}`);
}

console.log(lines.join('\n'));

if (!update && problems.length) {
  console.error(`\nscan-dist: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

if (!update) {
  const digest = createHash('sha256')
    .update(JSON.stringify([...domains.keys()].sort()))
    .digest('hex')
    .slice(0, 12);
  console.log(`scan-dist: OK (origin set ${digest})`);
}
