import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Offline guarantee: after the app loads, nothing may reach the network.
 * Two layers of proof:
 *   1. no runtime source file references an external origin, and
 *   2. the built entry document only references assets shipped in dist/
 *      (skipped with a note when dist has not been built yet).
 *
 * `scripts/` is deliberately excluded: it only runs at install/setup time
 * (e.g. fetching tessdata into public/), never in the browser.
 */

const ROOT = process.cwd();
const SRC_DIRS = ['src'];

/** Origins that are structural (XML namespaces) rather than network calls. */
const ALLOWED = [
  /^https?:\/\/www\.w3\.org\//,
  /^https?:\/\/schemas\./,
  /^https?:\/\/localhost/,
  // Self-referential link/og:image tags in index.html: the page pointing at
  // its own deployment is not a call out to a third party.
  /^https:\/\/row-data-converter(-[a-z0-9]+)?\.vercel\.app\//,
];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function externalUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s'"`)<>\\]+/g) ?? [];
  return [...new Set(matches.filter((url) => !ALLOWED.some((allowed) => allowed.test(url))))];
}

describe('offline: source', () => {
  it('never references an external origin', () => {
    const offenders: string[] = [];
    const files = [
      ...SRC_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))),
      path.join(ROOT, 'index.html'),
      path.join(ROOT, 'package.json'),
    ].filter((file) => /\.(ts|tsx|mjs|js|html|json)$/.test(file));

    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const url of externalUrls(text)) offenders.push(`${path.relative(ROOT, file)} → ${url}`);
    }

    expect(offenders).toEqual([]);
  });

  it('performs no top-level network calls', () => {
    const source = walk(path.join(ROOT, 'src'))
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');

    expect(source).not.toMatch(/\bnew\s+XMLHttpRequest\s*\(/);
    expect(source).not.toMatch(/\bnavigator\s*\.\s*sendBeacon/);
    // Every fetch() that does exist must be guarded to same-origin/blob URLs.
    const fetches = source.match(/fetch\s*\(/g) ?? [];
    expect(fetches.length).toBe(0);
  });
});

/**
 * The entry document must only reference assets shipped with the build.
 *
 * Scanning every bundled chunk for URL strings is not meaningful: vendor
 * libraries ship namespace URIs (OOXML), package homepages and overridden
 * default values as plain strings. Whether the app actually reaches the
 * network is proven at runtime instead, by recording every request the app
 * makes while converting a file (see the browser verification step).
 */
describe('offline: production build', () => {
  it('loads only local assets', () => {
    const dist = path.join(ROOT, 'dist');
    const entry = path.join(dist, 'index.html');
    if (!fs.existsSync(entry)) {
      console.warn('dist/ not built yet — run `npm run build` to verify the bundle.');
      return;
    }

    const html = fs.readFileSync(entry, 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    expect(refs.length).toBeGreaterThan(0);

    // Only self-origin absolute URLs (canonical, og:image) may be absolute;
    // everything else must be a relative, shipped asset.
    const external = refs.filter((ref) => /^(https?:)?\/\//i.test(ref));
    const selfOrigin = /^https:\/\/row-data-converter(-[a-z0-9]+)?\.vercel\.app\//;
    expect(external.filter((ref) => !selfOrigin.test(ref))).toEqual([]);
    // Every local asset resolves inside the build output.
    const localRefs = refs.filter(
      (ref) => !ref.startsWith('#') && !/^(https?:|data:)/i.test(ref),
    );
    for (const ref of localRefs) {
      expect(fs.existsSync(path.join(dist, ref.replace(/^\.\//, ''))), ref).toBe(true);
    }
  });
});
