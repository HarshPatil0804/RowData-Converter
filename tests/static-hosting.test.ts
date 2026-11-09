// @vitest-environment node
/**
 * Task G — there is no backend, and the artifact is static.
 *
 * A privacy claim is only as good as the host: a single serverless route, an
 * analytics script or a `functions/` directory would defeat every other test in
 * this repository, because those requests do not come from the page's own code
 * and the browser suites here only ever exercise `dist/`.
 *
 * So this suite asserts the shape of the project and of the build output, and
 * prints the file-type inventory that a reviewer can compare with the deploy
 * dashboard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');

/** Directories/entrypoints that would mean "there is a server". */
const SERVER_PATHS = [
  'api',
  'functions',
  'netlify/functions',
  'vercel/functions',
  'server',
  'serverless',
  'src/api',
  'src/pages/api',
  'src/app/api',
  'middleware.ts',
  'middleware.js',
  'serverless.yml',
  'serverless.yaml',
  'netlify.toml',
  'Dockerfile',
  'docker-compose.yml',
];

/** Packages that would add a runtime server, a hosted function or telemetry. */
const FORBIDDEN_DEPENDENCIES = [
  'next',
  'express',
  'koa',
  'fastify',
  '@hapi/hapi',
  '@vercel/analytics',
  '@vercel/speed-insights',
  '@vercel/node',
  '@vercel/edge',
  '@sentry/browser',
  '@sentry/react',
  'posthog-js',
  'mixpanel-browser',
  'amplitude-js',
  'firebase',
  'aws-sdk',
  '@aws-sdk/client-s3',
];

/** Everything a static host can serve without executing anything server-side. */
const STATIC_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.txt',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.svg',
  '.ico',
  '.gz',
  '.wasm',
  '.webmanifest',
  '.map',
]);

function walk(dir: string, prefix = ''): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    );
}

describe('static hosting', () => {
  it('the repository has no server, function or telemetry entrypoint', () => {
    const present = SERVER_PATHS.filter((candidate) => fs.existsSync(path.join(ROOT, candidate)));
    expect(present, `these paths would mean a backend: ${present.join(', ')}`).toEqual([]);

    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    const declared = {
      ...((manifest.dependencies as Record<string, string>) ?? {}),
      ...((manifest.devDependencies as Record<string, string>) ?? {}),
    };
    const found = FORBIDDEN_DEPENDENCIES.filter((name) => name in declared);
    console.log(JSON.stringify({ runtimeDependencies: Object.keys(manifest.dependencies ?? {}) }, null, 2));
    expect(found, `these packages imply a server or telemetry: ${found.join(', ')}`).toEqual([]);
  }, 60_000);

  it('vercel.json declares a static build and installs dependencies without scripts', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')) as Record<string, unknown>;
    console.log(JSON.stringify({ installCommand: config.installCommand, buildCommand: config.buildCommand, outputDirectory: config.outputDirectory, rewrites: config.rewrites }, null, 2));

    expect(config.installCommand).toBe('npm ci --ignore-scripts');
    expect(config.buildCommand).toBe('npm run build');
    expect(config.outputDirectory).toBe('dist');
    // No `functions`, `builds` or `routes`: the only dynamic-looking entry is
    // the SPA fallback, which every static host supports.
    expect(config.functions).toBeUndefined();
    expect(config.builds).toBeUndefined();
    expect(config.routes).toBeUndefined();
    const rewrites = (config.rewrites as { destination: string }[] | undefined) ?? [];
    expect(rewrites.map((rule) => rule.destination)).toEqual(['/index.html']);
  }, 60_000);

  it('ships the third-party notices and lists them in the integrity manifest', () => {
    const notices = path.join(DIST, 'THIRD_PARTY_NOTICES.txt');
    expect(fs.existsSync(notices), 'dist/THIRD_PARTY_NOTICES.txt must be built').toBe(true);
    const text = fs.readFileSync(notices, 'utf8');
    expect(text.startsWith('# Third-party notices')).toBe(true);
    expect(text).toContain('MIT License');
    expect(text).toContain('Apache-2.0');
    expect(text).toMatch(/Tesseract English language data/);

    const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'integrity.json'), 'utf8')) as {
      files: Record<string, string>;
    };
    expect(Object.keys(manifest.files)).toContain('THIRD_PARTY_NOTICES.txt');
  }, 60_000);

  it('every file in dist is a static file type', () => {
    expect(fs.existsSync(DIST), 'dist/ must be built before this test').toBe(true);
    const files = walk(DIST);
    expect(files.length).toBeGreaterThan(10);

    const counts: Record<string, number> = {};
    const unexpected: string[] = [];
    for (const file of files) {
      const extension = path.extname(file).toLowerCase();
      counts[extension || '(none)'] = (counts[extension || '(none)'] ?? 0) + 1;
      if (!STATIC_EXTENSIONS.has(extension)) unexpected.push(file);
    }

    const table = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([extension, count]) => `${String(count).padStart(4)} × ${extension}`)
      .join('\n');
    console.log(`dist/ file types (${files.length} files):\n${table}`);
    expect(unexpected, `not a static file type: ${unexpected.join(', ')}`).toEqual([]);
  }, 60_000);
});
