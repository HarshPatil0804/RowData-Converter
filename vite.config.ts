import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
        writeFileSync('dist/version.json', `${JSON.stringify({ hash: BUILD_HASH, builtAt: BUILT_AT })}\n`);
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