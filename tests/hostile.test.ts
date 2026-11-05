// @vitest-environment node
/**
 * Hostile corpus, pipeline side.
 *
 * Every generated file must end in exactly one of two ways: a readable result,
 * or a readable refusal. Nothing may hang, throw an internal error, or exhaust
 * memory. The browser side of the same corpus (script canary, CSP violations,
 * external requests) lives in tests/hostile-browser.test.ts.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { beforeAll, describe, expect, it } from 'vitest';
import { processBytes } from '../src/pipeline/index';
import { LIMITS } from '../src/pipeline/limits';

const DIR = path.resolve('tests/hostile');

function mime(name: string): string {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const map: Record<string, string> = {
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    png: 'image/png',
    zip: 'application/zip',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[extension] ?? 'application/octet-stream';
}

/** Which guard each file must trip, and the words the user must see. */
const MUST_REFUSE: [string, RegExp][] = [
  ['long-line.csv', /limit is 2 MB per line/i],
  ['many-columns.csv', /limit is 4,096/i],
  ['deep.json', /nested 10,000 levels deep/i],
  ['deep-object.json', /nested 5,000 levels deep/i],
  ['deep.xml', /nested 10,000 element levels deep/i],
  ['xxe.xml', /DOCTYPE or XML entities/i],
  ['huge-image.png', /megapixels/i],
  ['zip-bomb.zip', /zip bomb/i],
  ['many-entries.zip', /holds 10,001 files/i],
  ['nested.zip', /nested more than 3 levels deep/i],
];

describe('hostile corpus', () => {
  let files: string[] = [];

  beforeAll(() => {
    if (!fs.existsSync(DIR) || fs.readdirSync(DIR).length === 0) {
      execFileSync(process.execPath, ['scripts/generate-hostile.mjs'], { stdio: 'ignore' });
    }
    files = fs.readdirSync(DIR).filter((name) => fs.statSync(path.join(DIR, name)).isFile());
    expect(files.length).toBeGreaterThanOrEqual(20);
  }, 300_000);

  it('documents every limit it enforces', () => {
    expect(LIMITS.lineBytes).toBeGreaterThan(0);
    expect(LIMITS.columns).toBeGreaterThan(0);
    expect(LIMITS.nestingDepth).toBeGreaterThan(0);
    expect(LIMITS.archiveDepth).toBeGreaterThan(0);
    expect(LIMITS.imagePixels).toBeGreaterThan(0);
  });

  for (const [name, message] of MUST_REFUSE) {
    it(`refuses ${name} with a readable message`, async () => {
      const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, name)));
      const started = Date.now();
      await expect(processBytes(name, mime(name), bytes)).rejects.toThrow(message);
      // Refusal must be fast: a limit that takes 20 s to notice is a hang.
      expect(Date.now() - started).toBeLessThan(15_000);
    }, 60_000);
  }

  it('parses or rejects every remaining hostile file without crashing', async () => {
    const refused = new Set(MUST_REFUSE.map(([name]) => name));
    const failures: string[] = [];

    for (const name of files) {
      if (refused.has(name)) continue;
      const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, name)));
      const started = Date.now();
      try {
        const datasets = await processBytes(name, mime(name), bytes);
        expect(datasets.length).toBeGreaterThan(0);
        for (const dataset of datasets) {
          expect(dataset.columns.length).toBeGreaterThan(0);
          expect(dataset.report.rowsOut).toBeGreaterThanOrEqual(0);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A refusal is acceptable; an internal failure (TypeError, stack
        // overflow) is not — those mean a parser crashed rather than guarded.
        if (/Maximum call stack|out of memory|Cannot read propert|undefined is not/i.test(message)) {
          failures.push(`${name}: internal failure — ${message.slice(0, 160)}`);
        }
      }
      const elapsed = Date.now() - started;
      if (elapsed > 20_000) failures.push(`${name}: took ${elapsed} ms`);
    }

    expect(failures, failures.join('\n')).toEqual([]);
  }, 300_000);

  it('keeps script payloads as data, not code', async () => {
    const [dataset] = await processBytes(
      'xss-cells.csv',
      'text/csv',
      new Uint8Array(fs.readFileSync(path.join(DIR, 'xss-cells.csv'))),
    );
    const flat = dataset.rows.map((row) => row.map((cell) => String(cell ?? '')).join('|')).join('\n');
    // The payload survives verbatim as text — that is the point: it is data.
    expect(flat).toContain('<script>');
    expect(flat).toContain('onerror');
  });

  it('does not let prototype keys become object prototypes', async () => {
    const [dataset] = await processBytes(
      'proto-keys.csv',
      'text/csv',
      new Uint8Array(fs.readFileSync(path.join(DIR, 'proto-keys.csv'))),
    );
    const names = new Set(dataset.columns);
    // Column names may legitimately be called __proto__, but the object itself
    // must not have been polluted.
    expect(names.size).toBeGreaterThan(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });
});
