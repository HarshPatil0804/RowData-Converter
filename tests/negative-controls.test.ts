import { describe, expect, it } from 'vitest';
import { processBytes } from '../src/pipeline/index';
import type { Cell, Dataset } from '../src/types';

/**
 * The controls the tolerance rules must not break.
 *
 * Every class added in this round (S1–S3, T1–T5, N1–N3) is a normalisation that
 * could easily go too far: strip one symbol too many and `B+` becomes `B`, read
 * one digit run too eagerly and an id becomes a 2023 date, cluster one value too
 * greedily and `Q1` swallows `Q-1`. These cases pin the *other* side of each
 * rule, so a future threshold change that buys accuracy by merging things that
 * are not the same value fails here.
 *
 * Each assertion is on the cleaned dataset, compared as a multiset of distinct
 * output values: the reshaping (upper snake case for statuses, title case for
 * labels) changes the spelling but not the number of distinct values, which is
 * exactly what the merge rules decide.
 */

async function clean(header: string[], rows: string[][]): Promise<Dataset> {
  const text = [header.join(','), ...rows.map((row) => row.join(','))].join('\n');
  const sets = await processBytes('control.csv', 'text/csv', new TextEncoder().encode(text), {});
  return sets[0] as Dataset;
}

function column(dataset: Dataset, name: string): Cell[] {
  const at = dataset.columns.indexOf(name);
  expect(at, `column ${name} exists`).toBeGreaterThanOrEqual(0);
  return dataset.rows.map((row) => row[at] as Cell);
}

function distinct(values: Cell[]): string[] {
  return [...new Set(values.map((value) => (value === null ? '' : String(value))))].sort();
}

describe('S1 – symbol-only variants stay distinct, separator variants merge', () => {
  it('B, B+ and B- are three values, not one', async () => {
    const dataset = await clean(
      ['Rating', 'Branch'],
      [
        ['B', 'North'],
        ['B', 'North'],
        ['B+', 'North'],
        ['B+', 'South'],
        ['B-', 'South'],
        ['B-', 'South'],
        ['B', 'South'],
        ['B+', 'North'],
      ],
    );

    expect(distinct(column(dataset, 'rating'))).toHaveLength(3);
  });

  it('a trailing + is significant on its own', async () => {
    const dataset = await clean(
      ['Grade', 'Branch'],
      [
        ['A', 'North'],
        ['A', 'North'],
        ['A+', 'South'],
        ['A+', 'South'],
        ['A', 'South'],
        ['A+', 'North'],
      ],
    );

    expect(distinct(column(dataset, 'grade'))).toHaveLength(2);
  });

  it('S, M, L and XL are four sizes', async () => {
    const dataset = await clean(
      ['Size', 'Colour'],
      [
        ['S', 'Red'],
        ['M', 'Blue'],
        ['L', 'Red'],
        ['XL', 'Blue'],
        ['S', 'Blue'],
        ['M', 'Red'],
        ['L', 'Blue'],
        ['XL', 'Red'],
      ],
    );

    expect(distinct(column(dataset, 'size'))).toHaveLength(4);
  });

  it('Q1 and Q-1 are different values (letter→digit hyphen is content)', async () => {
    const dataset = await clean(
      ['Quarter', 'Region'],
      [
        ['Q1', 'North'],
        ['Q1', 'South'],
        ['Q-1', 'North'],
        ['Q-1', 'South'],
        ['Q1', 'North'],
        ['Q-1', 'South'],
      ],
    );

    expect(distinct(column(dataset, 'quarter'))).toHaveLength(2);
  });

  it('positive control: 10-A, 10 A, 10A and 10-a all merge', async () => {
    const dataset = await clean(
      ['Code', 'Region'],
      [
        ['10-A', 'North'],
        ['10 A', 'South'],
        ['10A', 'North'],
        ['10-a', 'South'],
        ['10-A', 'South'],
        ['10A', 'North'],
      ],
    );

    expect(distinct(column(dataset, 'code'))).toHaveLength(1);
  });
});

describe('T2 – codes that merely look like numbers stay text', () => {
  it('A1, B12, 3M and 4K are not stripped to numbers', async () => {
    const dataset = await clean(
      ['Sku', 'Stock'],
      [
        ['A1', '12'],
        ['B12', '4'],
        ['3M', '9'],
        ['4K', '3'],
        ['A2', '7'],
        ['B13', '5'],
      ],
    );

    expect(distinct(column(dataset, 'sku'))).toEqual(['3M', '4K', 'A1', 'A2', 'B12', 'B13']);
    expect(dataset.report.conversions.filter((entry) => entry.column === 'sku')).toHaveLength(0);
  });
});

describe('T3 – five-digit ids and amounts are never Excel serials', () => {
  it('an id column of five-digit numbers stays numeric', async () => {
    const dataset = await clean(
      ['Invoice', 'Amount'],
      [
        ['45012', '1200'],
        ['45013', '980'],
        ['45014', '1510'],
        ['45015', '770'],
        ['45016', '2040'],
        ['45017', '1310'],
      ],
    );

    expect(dataset.types[dataset.columns.indexOf('invoice')]).not.toBe('date');
    expect(distinct(column(dataset, 'invoice'))).toEqual(['45012', '45013', '45014', '45015', '45016', '45017']);
    expect(dataset.report.conversions.filter((entry) => entry.kind.startsWith('serial'))).toHaveLength(0);
  });

  it('an amount column of five-digit numbers stays numeric', async () => {
    const dataset = await clean(
      ['Shop', 'Total'],
      [
        ['North', '42130'],
        ['South', '41200'],
        ['North', '38990'],
        ['South', '45010'],
      ],
    );

    expect(dataset.types[dataset.columns.indexOf('total')]).not.toBe('date');
  });
});

describe('T4 – scores with mixed denominators are text, not fractions', () => {
  it('3/4, 1/2 and 5/8 in one column stay as written', async () => {
    const dataset = await clean(
      ['Pupil', 'Score'],
      [
        ['Ana', '3/4'],
        ['Ben', '1/2'],
        ['Cara', '5/8'],
        ['Dev', '3/4'],
        ['Eli', '2/3'],
        ['Fay', '1/2'],
      ],
    );

    expect(dataset.types[dataset.columns.indexOf('score')]).toBe('text');
    expect(distinct(column(dataset, 'score'))).toEqual(['1/2', '2/3', '3/4', '5/8']);
  });

  it('text ratios are not fractions', async () => {
    const dataset = await clean(
      ['Item', 'Ratio'],
      [
        ['Wheat', 'n/a'],
        ['Rice', '1:2'],
        ['Maize', '3 to 1'],
        ['Oats', 'n/a'],
        ['Barley', '2:1'],
        ['Rye', '1 to 3'],
      ],
    );

    expect(dataset.types[dataset.columns.indexOf('ratio')]).toBe('text');
  });
});

describe('N1 – a boolean column with words in it stays text', () => {
  it('yes plus prose is not a boolean column', async () => {
    const dataset = await clean(
      ['Consent', 'Patient'],
      [
        ['yes', 'Ana'],
        ['no', 'Ben'],
        ['pending review', 'Cara'],
        ['yes', 'Dev'],
        ['no', 'Eli'],
        ['asked twice', 'Fay'],
      ],
    );

    expect(dataset.types[dataset.columns.indexOf('consent')]).toBe('text');
    expect(distinct(column(dataset, 'consent'))).toEqual(['no', 'pending review', 'asked twice', 'yes'].sort());
  });

  it('mixed vocabularies in one column do not all become booleans', async () => {
    const dataset = await clean(
      ['Attended', 'Patient'],
      [
        ['yes', 'Ana'],
        ['true', 'Ben'],
        ['1', 'Cara'],
        ['no', 'Dev'],
        ['false', 'Eli'],
        ['0', 'Fay'],
      ],
    );

    // 1/0 and yes/no and true/false are three families; a cell that is ambiguous
    // must not be guessed, so the column stays as written.
    expect(dataset.types[dataset.columns.indexOf('attended')]).toBe('text');
  });
});
