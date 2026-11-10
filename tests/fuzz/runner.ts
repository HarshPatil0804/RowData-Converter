/**
 * Fuzz runner: build a messy file from ground truth + injectors, push it
 * through the REAL pipeline (processBytes), and compare the cleaned output
 * cell-by-cell against the tracked expectation.
 *
 * Fairness rules baked in here:
 *   - the case goes through the product path: `processBytes`, then the same
 *     `toCSV` the download button calls — grading reads the exported bytes,
 *     not the in-memory table;
 *   - the grader (`./canonical`) imports nothing from `src/pipeline` or
 *     `src/lib`, so a rule that merges two values cannot also make the grader
 *     call them equal;
 *   - expected values are ground truth (adjusted only where an injector
 *     rewrites the answer: poisoned numbers → null, packed text → packed
 *     text);
 *   - row accounting must be exact: rowsIn = clean + rejected + duplicates,
 *     rejected must equal the injected junk line count, and every expected
 *     column must exist in the output.
 */

import { processBytes } from '../../src/pipeline';
import type { Cell, Dataset } from '../../src/types';
import type { Tuning } from '../../src/pipeline/typing';
import { toCSV } from '../../src/lib/export';
import { parseCsv, sameCell, sameHeaderName } from './canonical';
import { INJECTORS, PHASES, serialize, type InjectContext } from './injectors';
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
  /** Columns no injector touched; verified against ground truth on their own. */
  unrelatedColumns: number;
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
    // Typing injectors (`late`) run after the formatting ones of the same phase.
    const ordered =
      phase === 'value'
        ? [...rng.shuffle(pool.filter((injector) => !injector.late)), ...rng.shuffle(pool.filter((injector) => injector.late))]
        : pool;
    for (const injector of ordered) injector.apply(ctx);
  }
  return { text: serialize(ctx), ctx };
}

function nullish(value: Cell | undefined | null): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** Snake-case a header name without using the pipeline's own helper. */
function toSnakeCase(name: string): string {
  const text = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/[_\s]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!text) return '';
  return /^[0-9]/.test(text) ? `col_${text}` : text;
}

const isBlankRow = (row: Cell[]): boolean => row.every((cell) => nullish(cell));

/** One record's identity, for matching a parsed record back to an injected row. */
const recordKey = (record: readonly string[]): string => {
  const fields = record.map((field) => field.trim());
  while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
  return fields.join('\u0001');
};

/**
 * How many records of the messy file are *not* the header, a data row or the
 * appended table — i.e. how many the pipeline is obliged to reject.
 *
 * Records are matched by identity and in order, never by subtraction, so the
 * count stays right when a junk line is itself split by the delimiter or when a
 * data row is blank.
 */
function countInjectedJunk(text: string, ctx: InjectContext): number {
  const raw = parseCsv(text, ctx.delimiter ?? ',');
  const records = raw.map(recordKey);
  // Only a genuinely empty line is trimmed by the extractor; `,,,,` is a record.
  const emptyText = (index: number): boolean => {
    const record = raw[index];
    return !record || (record.length === 1 && (record[0] as string).trim() === '');
  };
  const dataKeys = ctx.rows.map((row) => recordKey(row.map((cell) => (nullish(cell) ? '' : String(cell)))));
  const appendKeys = ctx.appendTable
    ? [
        recordKey(ctx.appendTable.header.map((cell) => (nullish(cell) ? '' : String(cell)))),
        ...ctx.appendTable.rows.map((row) => recordKey(row.map((cell) => (nullish(cell) ? '' : String(cell))))),
      ]
    : [];

  let head = 0;
  let tail = records.length - 1;
  while (head <= tail && emptyText(head)) head += 1;
  while (tail >= head && emptyText(tail)) tail -= 1;

  let dataAt = 0;
  let appendAt = 0;
  let junk = 0;
  for (let index = head + 1; index <= tail; index += 1) {
    const record = records[index] as string;
    if (dataAt < dataKeys.length && record === dataKeys[dataAt]) {
      dataAt += 1;
      continue;
    }
    if (appendAt < appendKeys.length && record === appendKeys[appendAt]) {
      appendAt += 1;
      continue;
    }
    junk += 1;
  }
  // A data row with no values at all is rejected too ("blank row"), and the
  // harness never expects it back, so it belongs in the same bucket.
  return junk + ctx.rows.filter(isBlankRow).length;
}

/** Generate the ground truth for a domain + seed (separate RNG stream). */
export function groundTruthFor(domain: Domain, seed: number): GroundTruth {
  return domain.generate(makeRng((seed ^ 0x9e3779b9) >>> 0));
}

/** Run one messy case through the real pipeline and grade it. */
export async function runCase(
  domain: Domain,
  seed: number,
  injectorNames: string[],
  tuning?: Partial<Tuning>,
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
    unrelatedColumns: 0,
    reviewMissing: [],
    errors: [],
  };

  const { text, ctx } = buildCase(gt, seed, injectorNames);

  let dataset: Dataset;
  let datasets: Dataset[] = [];
  try {
    const bytes = new TextEncoder().encode(text);
    datasets = await processBytes('fuzz.csv', 'text/csv', bytes, tuning ? { tuning } : {});
    dataset = datasets[0] as Dataset;
  } catch (error) {
    result.rowLoss = true;
    result.errors.push(`pipeline threw: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  // ---- row accounting -----------------------------------------------------
  // Walk the file's records and classify each one by identity: the first record
  // is the header, the injected data rows appear in order, the appended table
  // follows them, and anything left over is a junk line the pipeline *should*
  // reject. Counting records rather than lines matters because a junk line
  // whose payload contains the delimiter (`TOTAL,,,1` padding) is two records to
  // any RFC 4180 reader; counting by identity rather than by subtraction matters
  // because blank data rows are data, while blank injected lines are not.
  result.expectedRejected = countInjectedJunk(text, ctx);
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
    const key = row
      .map((cell) =>
        typeof cell === 'string'
          ? cell.trim().toLowerCase().replace(/\s+/g, ' ')
          : cell === null || cell === undefined
            ? ''
            : String(cell),
      )
      .join('\u0001');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!identityHolds || expectedFinal.length !== dataset.rows.length) result.rowLoss = true;
  // Only the lower bound is meaningful. A data row that went missing is caught
  // by the identity/row-count check above, so anything the pipeline rejects
  // beyond the injected junk is junk as well: rejecting too much junk is not a
  // failure (a junk line can even contain a delimiter or an unbalanced quote and
  // split into two records), but *missing* a junk line means it was kept as data.
  if (result.rejected < result.expectedRejected) {
    result.rowLoss = true;
    result.errors.push(
      `rejected count ${result.rejected} < injected junk lines ${result.expectedRejected}`,
    );
  }

  // ---- what the user actually gets: the CSV download, re-parsed ----------
  // `toCSV` is the export path the Download button uses, so a value the
  // exporter neutralises (apostrophe prefix), mangles or drops fails here.
  const grid = parseCsv(toCSV(dataset.columns, dataset.rows, { types: dataset.types }));
  const headerRow = grid[0] ?? [];
  const body = grid.slice(1);
  if (headerRow.length !== dataset.columns.length) {
    result.rowLoss = true;
    result.errors.push('exported CSV header does not match the dataset columns');
  }

  const mapping: { gtIndex: number; csvIndex: number }[] = [];
  for (let gtIndex = 0; gtIndex < gt.header.length; gtIndex += 1) {
    const name = ctx.colName.get(gtIndex) ?? toSnakeCase(gt.header[gtIndex]);
    const hit = headerRow.findIndex((header) => sameHeaderName(header, name));
    if (hit < 0) {
      result.missingColumns.push(name);
    } else {
      mapping.push({ gtIndex, csvIndex: hit });
    }
  }

  // ---- cell-by-cell, on the downloaded bytes ------------------------------
  // A column no injector touched is "unrelated": its cells are ground truth and
  // must come back byte-identical. Mixing four injectors is exactly where a rule
  // for one column can leak into a neighbour (a numeric plan applied to a text
  // column, a note column stealing a value), so those columns are asserted on
  // their own as well as through the overall accuracy.
  const asText = (cell: Cell | undefined | null): string | null => (nullish(cell) ? null : String(cell));
  const untouched = new Set<number>();
  for (let gtIndex = 0; gtIndex < gt.header.length; gtIndex += 1) {
    const same = ctx.expected.every((row, rowIndex) =>
      sameCell(asText(row[gtIndex]), asText(gt.rows[rowIndex]?.[gtIndex])),
    );
    if (same) untouched.add(gtIndex);
  }
  result.unrelatedColumns = untouched.size;
  const unrelatedProblems = new Map<string, string>();

  const rows = Math.min(expectedFinal.length, body.length);
  if (body.length !== expectedFinal.length) result.rowLoss = true;
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const expectedRow = expectedFinal[rowIndex];
    const cleanRow = body[rowIndex] ?? [];
    for (const { gtIndex, csvIndex } of mapping) {
      result.cellsTotal += 1;
      const expectedCell = expectedRow[gtIndex];
      const actualCell = cleanRow[csvIndex] ?? null;
      if (sameCell(expectedCell, actualCell)) {
        result.cellsMatch += 1;
      } else if (result.errors.length < 8) {
        result.errors.push(
          `row ${rowIndex} ${ctx.colName.get(gtIndex)}: expected ${JSON.stringify(
            expectedCell,
          )} got ${JSON.stringify(actualCell)}`,
        );
      }
      if (untouched.has(gtIndex) && !sameCell(asText(gt.rows[rowIndex]?.[gtIndex]), actualCell)) {
        unrelatedProblems.set(
          ctx.colName.get(gtIndex) ?? String(gtIndex),
          `row ${rowIndex}: expected ${JSON.stringify(gt.rows[rowIndex]?.[gtIndex] ?? null)} got ${JSON.stringify(actualCell)}`,
        );
      }
    }
  }
  if (unrelatedProblems.size > 0) {
    result.rowLoss = true;
    for (const [column, detail] of unrelatedProblems) {
      result.errors.push(`unrelated column ${column} changed – ${detail}`);
    }
  }
  result.accuracy = result.cellsTotal === 0 ? 1 : result.cellsMatch / result.cellsTotal;

  // ---- S2: the appended table must be its own dataset, graded on its own ---
  if (ctx.appendTable && ctx.expect.secondTable) {
    const second = datasets[1];
    if (!second) {
      result.rowLoss = true;
      result.errors.push('second table was not split into its own dataset');
    } else {
      const secondGrid = parseCsv(toCSV(second.columns, second.rows, { types: second.types }));
      const secondHeader = secondGrid[0] ?? [];
      const secondBody = secondGrid.slice(1);
      const { header, expected } = ctx.expect.secondTable;
      const columns = header.map((name, index) => ({ index, at: secondHeader.findIndex((h) => sameHeaderName(h, name)) }));
      for (const column of columns) {
        if (column.at < 0) result.missingColumns.push(`table2:${header[column.index]}`);
      }
      if (secondBody.length !== expected.length) {
        result.rowLoss = true;
        result.errors.push(`second table has ${secondBody.length} rows, expected ${expected.length}`);
      }
      for (let rowIndex = 0; rowIndex < Math.min(expected.length, secondBody.length); rowIndex += 1) {
        for (const column of columns) {
          if (column.at < 0) continue;
          result.cellsTotal += 1;
          const expectedCell = expected[rowIndex]?.[column.index] ?? null;
          const actualCell = secondBody[rowIndex]?.[column.at] ?? null;
          if (sameCell(expectedCell, actualCell)) result.cellsMatch += 1;
          else if (result.errors.length < 8) {
            result.errors.push(
              `table2 row ${rowIndex} ${header[column.index]}: expected ${JSON.stringify(expectedCell)} got ${JSON.stringify(actualCell)}`,
            );
          }
        }
      }
      result.accuracy = result.cellsTotal === 0 ? 1 : result.cellsMatch / result.cellsTotal;
    }
  }

  // ---- honesty checks (ambiguity / low confidence must be surfaced) -------
  if (report.ambiguousDates > 0 && !dataset.review.some((item) => item.kind === 'date_order')) {
    result.reviewMissing.push('date_order');
  }
  if (ctx.expect.similarValues) {
    const listed = report.mappings.some((mapping) => String(mapping.from).startsWith('review: similar')) ||
      dataset.review.some((item) => item.kind === 'similar_values');
    if (!listed) result.reviewMissing.push('similar_values');
  }
  if (ctx.expect.repeatedHeader) {
    const rejected = report.rejectedReasons.some((reason) => reason.reason === 'repeated header');
    if (!rejected) result.reviewMissing.push('repeated_header');
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

