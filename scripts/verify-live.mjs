#!/usr/bin/env node
/**
 * Prove that the files the deployed site serves are the files this commit built.
 *
 * `dist/version.json` names the commit and carries the SHA-256 of
 * `dist/integrity.json`; `integrity.json` carries the SHA-256 of every other
 * shipped file. So one download of version.json plus one of integrity.json,
 * then a hash per file, decides whether production is running this build —
 * including whether any file was modified after upload.
 *
 * Usage:
 *   npm run verify-live                      # uses LIVE_URL / --url / the default
 *   npm run verify-live -- --url https://…
 *   npm run verify-live -- --allow-stale     # warn instead of failing on an old
 *                                            # commit (a deploy may still be running)
 *
 * Exit codes: 0 verified, 1 mismatch, 2 unreachable.
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] ?? '');
};
const allowStale = args.includes('--allow-stale');
const configured = flag('--url') || process.env.LIVE_URL || 'https://row-data-converter.vercel.app';
const BASE = configured.replace(/\/$/, '');

function localCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

const expectedCommit = flag('--expect') ?? localCommit();
const failures = [];
const notes = [];

async function get(path) {
  const url = `${BASE}${path}`;
  const response = await fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), url };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

let version;
let integrityBytes;
try {
  const versionFile = await get('/version.json');
  version = JSON.parse(versionFile.bytes.toString('utf8'));
  integrityBytes = (await get('/integrity.json')).bytes;
} catch (error) {
  console.error(`verify-live: UNREACHABLE ${BASE} — ${error.message}`);
  process.exit(2);
}

console.log(`verify-live: ${BASE}`);
console.log(`  live commit      ${version.hash ?? '(missing)'}`);
console.log(`  live build time  ${version.builtAt ?? '(missing)'}`);
if (expectedCommit) console.log(`  local commit     ${expectedCommit}`);

if (expectedCommit && version.hash !== expectedCommit) {
  const message = `live commit ${version.hash} != local ${expectedCommit}`;
  if (allowStale) notes.push(message);
  else failures.push(message);
}

const integrityDigest = sha256(integrityBytes);
if (version.integrity !== integrityDigest) {
  failures.push(`integrity.json hash ${integrityDigest} != version.json's ${version.integrity ?? '(missing)'}`);
} else {
  console.log(`  integrity.json   ${integrityDigest} (matches version.json)`);
}

let manifest;
try {
  manifest = JSON.parse(integrityBytes.toString('utf8'));
} catch (error) {
  console.error(`verify-live: integrity.json is not JSON — ${error.message}`);
  process.exit(1);
}

const files = manifest.files ?? {};
const names = Object.keys(files).sort();
let checked = 0;
const decompressed = [];

/**
 * A `.gz` asset may come back decompressed: servers (and `vite preview`) can
 * add `Content-Encoding: gzip` for a file that is already gzipped, and fetch
 * decodes it transparently. So the comparison is made on both forms of each
 * side — the bytes themselves, and the gunzipped payload when that applies.
 */
function hashes(bytes) {
  const out = new Set([sha256(bytes)]);
  try {
    out.add(sha256(gunzipSync(bytes)));
  } catch {
    // Not gzip: the raw hash is the only meaningful one.
  }
  return out;
}

function matchesDecompressed(name, liveBytes) {
  if (!name.endsWith('.gz') || !existsSync(`dist/${name}`)) return false;
  const local = hashes(readFileSync(`dist/${name}`));
  for (const digest of hashes(liveBytes)) if (local.has(digest)) return true;
  return false;
}
for (const name of names) {
  const local = `dist/${name}`;
  if (existsSync(local)) {
    const localDigest = sha256(readFileSync(local));
    if (localDigest !== files[name]) {
      failures.push(`${name}: dist/ has ${localDigest}, manifest says ${files[name]} (build is stale — run npm run build)`);
    }
  }
  let live;
  try {
    live = await get(`/${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    continue;
  }
  const digest = sha256(live.bytes);
  if (digest === files[name]) {
    checked += 1;
  } else if (matchesDecompressed(name, live.bytes)) {
    checked += 1;
    decompressed.push(name);
  } else {
    failures.push(`${name}: live ${digest} != manifest ${files[name]}`);
  }
}

console.log(`  files verified   ${checked}/${names.length}`);
if (decompressed.length) {
  console.log(`  decompressed     ${decompressed.join(', ')} (server sent Content-Encoding: gzip; payload matches)`);
}

if (notes.length) console.log(`\nverify-live: notes\n${notes.map((n) => `  - ${n}`).join('\n')}`);

if (failures.length) {
  console.error(`\nverify-live: FAILED (${failures.length})\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}

console.log('\nverify-live: OK — the deployed files match this build byte for byte.');
