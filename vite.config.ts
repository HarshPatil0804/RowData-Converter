import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// ---- build stamp: git short hash + ISO build time -------------------------
function gitShortHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

const BUILD_HASH = gitShortHash();
const BUILT_AT = new Date().toISOString();

/** Every regular file under a directory, recursively, in a stable order. */
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Everything is bundled: no CDN scripts, so the built app runs fully offline.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'build-stamp',
      transformIndexHtml() {
        return [
          {
            tag: 'meta',
            attrs: { name: 'build', content: BUILD_HASH },
            injectTo: 'head',
          },
        ];
      },
      closeBundle() {
        // Precache list for the service worker: every content-hashed bundle,
        // including the workers, so the app opens (and converts) with no
        // network. Written at build time because the hashes only exist now.
        const assetsDir = join('dist', 'assets');
        const assets = existsSync(assetsDir)
          ? readdirSync(assetsDir).map((name) => `./assets/${name}`)
          : [];
        writeFileSync('dist/assets.json', `${JSON.stringify({ hash: BUILD_HASH, assets })}\n`);

        // Integrity chain: integrity.json holds the SHA-256 of every file we
        // upload, and version.json holds the SHA-256 of integrity.json. A
        // visitor (or `npm run verify-live`) can therefore prove that what the
        // server hands out is exactly what this build produced.
        //
        // version.json is excluded because it cannot contain its own hash, and
        // integrity.json is excluded because it cannot contain its own either;
        // both are covered by the commit hash and by the chain respectively.
        const files: Record<string, string> = {};
        for (const file of walk('dist')) {
          const key = relative('dist', file).split(sep).join('/');
          if (key === 'version.json' || key === 'integrity.json') continue;
          files[key] = createHash('sha256').update(readFileSync(file)).digest('hex');
        }
        const ordered: Record<string, string> = {};
        for (const key of Object.keys(files).sort()) ordered[key] = files[key];
        const integrityBody = `${JSON.stringify({ algorithm: 'sha256', hash: BUILD_HASH, files: ordered }, null, 2)}\n`;
        writeFileSync('dist/integrity.json', integrityBody);
        const integrity = createHash('sha256').update(integrityBody).digest('hex');

        // The only file that may differ between two builds of the same commit:
        // builtAt is the one timestamp, and it lives here alone.
        writeFileSync(
          'dist/version.json',
          `${JSON.stringify({ hash: BUILD_HASH, builtAt: BUILT_AT, integrity }, null, 2)}\n`,
        );
      },
    },
  ],
  define: {
    __BUILD_HASH__: JSON.stringify(BUILD_HASH),
    __BUILD_AT__: JSON.stringify(BUILT_AT),
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-polyfills.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: 'forks',
    reporters: ['default'],
  },
});