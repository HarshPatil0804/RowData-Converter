/**
 * Fuzz runner: build a messy file from ground truth + injectors, push it
 * through the REAL pipeline (processBytes), and compare the cleaned output
 * cell-by-cell against the tracked expectation.
 *
 * Fairness rules baked in here:
 *   - expected values are ground truth (adjusted only where an injector
 *     rewrites the answer: poisoned numbers → null, packed text → packed
 *     text);
 *   - comparison is canonicalized (trim/case/space, punctuation folded) so
 *     style mess cannot score as a data error, but wrong values always do;
 *   - row accounting must be exact: rowsIn = clean + rejected + duplicates,
 *     rejected must equal the injected junk line count, and every expected
 *     column must exist in the output.
 */

import { processBytes } from '../../src/pipeline';
import type { Cell, Dataset } from '../../src/types';
import { categoryKey, cleanText, displayCell, toSnakeCase } from '../../src/lib/strings';
import { parseNumberValue } from '../../src/lib/numbers';
import {
  INJECTORS,
  PHASES,
  serialLines,
  serialize,
  type InjectContext,
} from './injectors';
import type { Domain, GroundTruth } from './generators';
import { makeRng } from './random';

export interface CaseResult {
  /** e.g. "retail orders · currency · seed 7". */
  label: string;
  domain: string;
  injectors: string[];
  comboSize: number;
  seed: number;
  cellsTotal: number;
  cellsMatch: number;
  accuracy: number;
  /** rowsIn identity broken or expected/clean row counts differ. */
  rowLoss: boolean;
  rejected: number;
  expectedRejected: number;
  missingColumns: string[];
  /** Review items the injected mess demands but the pipeline did not file. */
  reviewMissing: string[];
  /** First few cell mismatches, for diagnosis. */
  errors: string[];
}

export interface BuiltCase {
  text: string;
  ctx: InjectContext;
}

/** Apply the selected injectors in phase order and serialize. */
export function buildCase(gt: GroundTruth, seed: number, injectorNames: string[]): BuiltCase {
  const rng = makeRng(seed);
  const ctx: InjectContext = {
    rng,
    gt,
    header: [...gt.header],
    rows: gt.rows.map((row) => [...row]),
    expected: gt.rows.map((row) => [...row]),
    position: gt.header.map((_name, index) => index),
    colName: new Map(gt.header.map((name, index) => [index, toSnakeCase(name)])),
    mergedColumns: new Set<number>(),
    parenColumns: new Set<number>(),
    overlapColumns: new Set<number>(),
    preamble: [],
    interior: [],
    footer: [],
    netRowAdds: 0,
    expect: {},
  };
  const chosen = new Set(injectorNames);

  for (const phase of PHASES) {
    const pool = INJECTORS.filter((injector) => injector.phase === phase && chosen.has(injector.name));
    // Value-phase order is shuffled per seed; structural phases keep their
    // fixed order (merge → split → duplicate → decorate → serialize).
    const ordered = phase === 'value' ? rng.shuffle(pool) : pool;
    for (const injector of ordered) injector.apply(ctx);
  }
  return { text: serialize(ctx), ctx };
}

function nullish(value: Cell): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function normalize(value: Cell): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return cleanText(String(value)).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Canonicalized cell equality (principle: compare after canonicalization). */
export function sameCell(expected: Cell, actual: Cell): boolean {
  if (nullish(expected) || nullish(actual)) return nullish(expected) && nullish(actual);
  if (typeof expected === 'number' || typeof actual === 'number') {
    const a = typeof expected === 'number' ? expected : parseNumberValue(expected);
    const b = typeof actual === 'number' ? actual : parseNumberValue(actual);
    if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b)) {
      return Math.abs(a - b) < 0.005;
    }
    return false;
  }
  const left = normalize(expected);
  const right = normalize(actual);
  if (left === right) return true;
  // Case/space/punctuation folding: "Paid" vs "PAID " vs "paid."
  return categoryKey(left) === categoryKey(right);
}

function foldName(name: string): string {
  return cleanText(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const isBlankRow = (row: Cell[]): boolean => row.every((cell) => nullish(cell));

/** Generate the ground truth for a domain + seed (separate RNG stream). */
export function groundTruthFor(domain: Domain, seed: number): GroundTruth {
  return domain.generate(makeRng((seed ^ 0x9e3779b9) >>> 0));
}

/** Run one messy case through the real pipeline and grade it. */
export async function runCase(
  domain: Domain,
  seed: number,
  injectorNames: string[],
): Promise<CaseResult> {
  const gt = groundTruthFor(domain, seed);
  const label = `${domain.name} · ${injectorNames.join(' + ') || 'clean'} · seed ${seed}`;
  const result: CaseResult = {
    label,
    domain: domain.name,
    injectors: injectorNames,
    comboSize: injectorNames.length,
    seed,
    cellsTotal: 0,
    cellsMatch: 0,
    accuracy: 1,
    rowLoss: false,
    rejected: -1,
    expectedRejected: -1,
    missingColumns: [],
    reviewMissing: [],
    errors: [],
  };

  const { text, ctx } = buildCase(gt, seed, injectorNames);

  let dataset: Dataset;
  try {
    const bytes = new TextEncoder().encode(text);
    const datasets = await processBytes('fuzz.csv', 'text/csv', bytes, {});
    dataset = datasets[0];
  } catch (error) {
    result.rowLoss = true;
    result.errors.push(`pipeline threw: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  // ---- row accounting -----------------------------------------------------
  // parseDelimited trims the file's outer whitespace first, so leading and
  // trailing blank lines never reach the parser; every remaining line — junk,
  // blank or data — does, and R1 rejects the junk and blank ones. Expected
  // rejected is therefore: surviving lines − header − kept (non-blank) data rows.
  const lines = serialLines(ctx);
  let head = 0;
  let tail = lines.length - 1;
  while (head <= tail && (lines[head] as string).trim() === '') head += 1;
  while (tail >= head && (lines[tail] as string).trim() === '') tail -= 1;
  const survivingLines = tail - head + 1;
  const keptDataRows = ctx.rows.filter((row) => !isBlankRow(row)).length;
  result.expectedRejected = survivingLines - 1 - keptDataRows;
  result.rejected = dataset.rejected.length;

  const report = dataset.report;
  const identityHolds =
    report.rowsIn === report.rowsOut + report.rejectedCount + report.duplicatesRemoved &&
    report.rejectedCount === result.rejected;

  // Expected kept rows, deduped the way the pipeline dedupes (R8).
  // R14 is part of that contract: a column with some ids missing gets a
  // generated_id, so two otherwise identical rows whose id is MISSING are two
  // records and must stay two rows. Only rows with ids can collapse.
  const expectedKept = ctx.expected.filter((row) => !isBlankRow(row));
  const idLike = ctx.gt.header
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => /(?:^|[_ -])(id|ids|no|num|number|code|key|ref)(?:$|[_ -])/i.test(name))
    .map(({ index }) => index)
    .filter((index) => {
      const values = expectedKept.map((row) => row[index]);
      return values.some(nullish) && values.some((value) => !nullish(value));
    });
  const hasMissingId = (row: Cell[]): boolean => idLike.some((index) => nullish(row[index]));

  const seen = new Set<string>();
  const pinned: Cell[][] = [];
  const expectedFinal = expectedKept.filter((row) => {
    if (hasMissingId(row)) {
      pinned.push(row);
      return true;
    }
    const key = row.map((cell) => (typeof cell === 'string' ? cleanText(cell).trim().toLowerCase() : cell === null || cell === undefined ? '' : String(cell))).join('\u0001');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!identityHolds || expectedFinal.length !== dataset.rows.length) result.rowLoss = true;
  if (result.rejected !== result.expectedRejected) {
    result.rowLoss = true;
    result.errors.push(
      `rejected count ${result.rejected} ≠ injected junk lines ${result.expectedRejected}`,
    );
  }

  // ---- column mapping -----------------------------------------------------
  const cleanIndex = new Map<string, number>();
  dataset.columns.forEach((name, index) => {
    if (!cleanIndex.has(name)) cleanIndex.set(name, index);
    const folded = foldName(name);
    if (!folded) return;
    if (!cleanIndex.has(folded)) cleanIndex.set(folded, index);
  });

  const mapping: { gtIndex: number; cleanIndex: number }[] = [];
  for (let gtIndex = 0; gtIndex < gt.header.length; gtIndex += 1) {
    const name = ctx.colName.get(gtIndex) ?? toSnakeCase(gt.header[gtIndex]);
    const hit = cleanIndex.get(name) ?? cleanIndex.get(foldName(name));
    if (hit === undefined) {
      result.missingColumns.push(name);
    } else {
      mapping.push({ gtIndex, cleanIndex: hit });
    }
  }

  // ---- cell-by-cell -------------------------------------------------------
  const rows = Math.min(expectedFinal.length, dataset.rows.length);
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const expectedRow = expectedFinal[rowIndex];
    const cleanRow = dataset.rows[rowIndex];
    for (const { gtIndex, cleanIndex: columnIndex } of mapping) {
      result.cellsTotal += 1;
      const expectedCell = expectedRow[gtIndex];
      const actualCell = cleanRow[columnIndex] ?? null;
      if (sameCell(expectedCell, actualCell)) {
        result.cellsMatch += 1;
      } else if (result.errors.length < 8) {
        result.errors.push(
          `row ${rowIndex} ${ctx.colName.get(gtIndex)}: expected ${JSON.stringify(
            expectedCell,
          )} got ${JSON.stringify(actualCell)}`,
        );
      }
    }
  }
  result.accuracy = result.cellsTotal === 0 ? 1 : result.cellsMatch / result.cellsTotal;

  // ---- honesty checks (ambiguity / low confidence must be surfaced) -------
  if (report.ambiguousDates > 0 && !dataset.review.some((item) => item.kind === 'date_order')) {
    result.reviewMissing.push('date_order');
  }
  if (ctx.expect.overlap) {
    const listed =
      report.overlapping.length > 0 || dataset.review.some((item) => item.kind === 'overlap');
    if (!listed) result.reviewMissing.push('overlap');
  }
  if (injectorNames.includes('missing ids') && gt.header.some((name, i) => ctx.position[i] >= 0)) {
    const fired = report.rulesFired.includes('R14');
    const reviewed = dataset.review.some((item) => item.kind === 'missing_id');
    if (!fired && !reviewed) result.reviewMissing.push('missing_id');
  }
  if (ctx.expect.rowCountControl) {
    const control = report.rowControl;
    if (!control) result.reviewMissing.push('row_control');
    else if (!control.matches) {
      result.rowLoss = true;
      result.errors.push(
        `row control mismatch: file says ${control.reported}, clean has ${control.actual}`,
      );
    }
  }
  if (report.reviewItems.some((item) => item.confidence < 0.8)) {
    const covered = new Set(dataset.review.map((item) => item.id));
    for (const item of report.reviewItems) {
      if (item.confidence < 0.8 && !covered.has(item.id)) result.reviewMissing.push(item.id);
    }
  }

  return result;
}

/** Sanity helper used by the report script: run a Dataset through checks. */
export async function processText(name: string, text: string): Promise<Dataset> {
  const bytes = new TextEncoder().encode(text);
  const datasets = await processBytes(name, 'text/csv', bytes, {});
  return datasets[0];
}

export { displayCell };
