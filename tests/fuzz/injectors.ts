/**
 * Composable mess injectors (Task B).
 *
 * Each injector is independent and knows nothing about the others. They run in
 * fixed phases so combinations stay meaningful:
 *
 *   1. value   – rewrite cell contents (case, whitespace, quotes, dates,
 *                currency, text-in-numeric, spelled numbers, id decoration,
 *                multi-item cells, overlapping categories);
 *   2. columns – merge/split columns (key=value packing, "A / B" composites,
 *                parenthetical qualifiers);
 *   3. rows    – add rows (conflicting copies, exact duplicates, preamble,
 *                footer, blank rows);
 *   4. file    – serialization (delimiter, BOM, newline mix).
 *
 * Expectations model: `ctx.expected` stays parallel to `ctx.rows` and holds
 * what the CLEAN output must contain for each row (ground truth, adjusted
 * where an injector changes the answer: poisoned numbers become null, packed
 * text becomes the packed text). Column identity lives in `ctx.colName`
 * (ground-truth index → clean column name). Nothing is ever inferred from
 * column names or domain words – only from values and statistics.
 */

import type { Cell } from '../../src/types';
import { toSnakeCase } from '../../src/lib/strings';
import type { RNG } from './random';
import type { GroundTruth } from './generators';

export type InjectorPhase = 'value' | 'columns' | 'rows' | 'file';

export interface InjectExpectations {
  /** R15: the file carries a "Total rows: N" line that must reconcile. */
  rowCountControl?: boolean;
  /** R18: an overlapping combination value must be listed for review. */
  overlap?: boolean;
}

export interface InjectContext {
  rng: RNG;
  /** Ground truth (read-only). */
  gt: GroundTruth;
  /** Mutable messy header (may be case/whitespace mangled). */
  header: string[];
  /** Messy data rows (mutated by injectors). */
  rows: Cell[][];
  /** Expected clean row content, parallel to `rows` (GT-column layout). */
  expected: Cell[][];
  /** GT column → current index inside a messy row (−1 when merged away). */
  position: number[];
  /** GT column → expected clean column name. */
  colName: Map<number, string>;
  /** GT columns merged into composites. */
  mergedColumns: Set<number>;
  /** GT columns rewritten with parenthetical qualifiers (R16). */
  parenColumns: Set<number>;
  /** GT columns carrying overlapping combinations (R18). */
  overlapColumns: Set<number>;
  /** Rows inserted after the header (single-cell lines). */
  preamble: Cell[][];
  /** Rows appended after the data (single-cell lines). */
  footer: Cell[][];
  /** Net rows added that survive cleaning (conflicting copies). */
  netRowAdds: number;
  delimiter?: string;
  bom?: boolean;
  mixedNewlines?: boolean;
  expect: InjectExpectations;
}

export interface Injector {
  name: string;
  phase: InjectorPhase;
  apply(ctx: InjectContext): void;
}

// ------------------------------------------------------------- column kinds ---

export type Kind = 'id' | 'date' | 'number' | 'boolean' | 'text';

function columnKind(values: Cell[]): Kind {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return 'text';
  if (present.every((value) => typeof value === 'boolean')) return 'boolean';
  if (present.every((value) => typeof value === 'number')) {
    const keys = new Set(present.map(String));
    if (present.length >= 8 && keys.size / present.length >= 0.95 && present.every((v) => Number.isInteger(v))) {
      return 'id';
    }
    return 'number';
  }
  if (present.every((value) => typeof value === 'string')) {
    const iso = present.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value as string)).length;
    if (iso / present.length >= 0.8) return 'date';
    const numeric = present.filter((value) => value !== '' && Number.isFinite(Number(value))).length;
    if (numeric / present.length >= 0.9) return 'number';
    return 'text';
  }
  return 'text';
}

export function ofKind(ctx: InjectContext, kind: Kind): number[] {
  const out: number[] = [];
  ctx.gt.header.forEach((_name, index) => {
    if (columnKind(ctx.gt.rows.map((row) => row[index])) === kind) out.push(index);
  });
  return out;
}

/** Text columns free of characters that would trip R5/R16 by accident. */
function cleanTextColumns(ctx: InjectContext, requireNoNulls = false): number[] {
  return ofKind(ctx, 'text').filter((index) => {
    const values = ctx.gt.rows.map((row) => row[index]);
    if (requireNoNulls && values.some((value) => value === null)) return false;
    return values.every((value) => {
      if (value === null) return true;
      const text = String(value);
      return !/[();=]/.test(text) && !/\s[-–—]\s/.test(text) && !/\s\/\s/.test(text);
    });
  });
}

/** Drop a merged GT column from the messy layout (keeps `expected` intact). */
function dropColumn(ctx: InjectContext, gtIndex: number): void {
  const at = ctx.position[gtIndex];
  if (at < 0) return;
  ctx.rows.forEach((row) => row.splice(at, 1));
  ctx.header.splice(at, 1);
  ctx.position.forEach((position, index) => {
    if (position > at) ctx.position[index] = position - 1;
  });
  ctx.position[gtIndex] = -1;
  ctx.mergedColumns.add(gtIndex);
}

// ------------------------------------------------------------ value phase ----

const caseInjector: Injector = {
  name: 'case',
  phase: 'value',
  apply(ctx) {
    const mutate = (text: string): string => {
      const mode = ctx.rng.int(0, 2);
      if (mode === 0) return text.toUpperCase();
      if (mode === 1) return text.toLowerCase();
      return text
        .split('')
        .map((char) => (ctx.rng.chance(0.5) ? char.toUpperCase() : char.toLowerCase()))
        .join('');
    };
    ctx.header = ctx.header.map((name) => (ctx.rng.chance(0.6) ? mutate(name) : name));
    ctx.rows = ctx.rows.map((row) =>
      row.map((cell) => {
        if (typeof cell === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(cell) && ctx.rng.chance(0.5)) {
          return mutate(cell);
        }
        if (typeof cell === 'boolean' && ctx.rng.chance(0.5)) return String(cell).toUpperCase();
        return cell;
      }),
    );
  },
};

const whitespaceInjector: Injector = {
  name: 'whitespace',
  phase: 'value',
  apply(ctx) {
    const messy = (text: string): string => {
      let out = text;
      if (ctx.rng.chance(0.4)) out = `   ${out}`;
      if (ctx.rng.chance(0.4)) out = `${out}  `;
      if (ctx.rng.chance(0.3)) out = out.replace(/ /g, '  ');
      if (ctx.rng.chance(0.15)) out = out.replace(/ /g, '\u00a0');
      return out;
    };
    ctx.header = ctx.header.map((name) => (ctx.rng.chance(0.5) ? ` ${name} ` : name));
    ctx.rows = ctx.rows.map((row) =>
      row.map((cell) => (typeof cell === 'string' && ctx.rng.chance(0.5) ? messy(cell) : cell)),
    );
  },
};

const quotesInjector: Injector = {
  name: 'quotes',
  phase: 'value',
  apply(ctx) {
    ctx.rows = ctx.rows.map((row) =>
      row.map((cell) => {
        if (cell === null || !ctx.rng.chance(0.5)) return cell;
        const quote = ctx.rng.chance(0.5) ? '"' : "'";
        return `${quote}${String(cell)}${quote}`;
      }),
    );
  },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function renderDate(iso: string, format: string): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const mon = MONTHS[month - 1];
  const pad = (value: number): string => String(value).padStart(2, '0');
  switch (format) {
    case 'DD/MM/YYYY':
      return `${pad(day)}/${pad(month)}/${year}`;
    case 'D/M/YYYY':
      return `${day}/${month}/${year}`;
    case 'DD-MM-YYYY':
      return `${pad(day)}-${pad(month)}-${year}`;
    case 'DD.MM.YY':
      return `${pad(day)}.${pad(month)}.${String(year).slice(2)}`;
    case 'D Mon YYYY':
      return `${day} ${mon} ${year}`;
    case 'Mon D, YYYY':
      return `${mon} ${day}, ${year}`;
    case 'DD Mon YYYY':
      return `${pad(day)} ${mon} ${year}`;
    default:
      return iso;
  }
}

/**
 * Mixed date formats. Every numeric shape (separator + year length) is
 * *proved* by at least one date whose day is > 12, written day-first, so the
 * pipeline's per-pattern inference recovers the true reading for that shape;
 * the remaining values of the same shape follow the proof. Named-month shapes
 * are never ambiguous. Each cell's expected value stays the ground-truth ISO.
 */
const mixedDates: Injector = {
  name: 'mixed dates',
  phase: 'value',
  apply(ctx) {
    const dateColumns = ofKind(ctx, 'date');
    for (const column of dateColumns) {
      const rowIndexes: number[] = [];
      ctx.gt.rows.forEach((row, index) => {
        if (typeof row[column] === 'string') rowIndexes.push(index);
      });
      if (rowIndexes.length === 0) continue;

      const dayOf = (rowIndex: number): number =>
        Number(String(ctx.gt.rows[rowIndex][column]).slice(8, 10));

      // Numeric shapes that must each carry one day>12 proof.
      const shapes: { separator: string; yearLen: 2 | 4; formats: string[] }[] = [
        { separator: '/', yearLen: 4, formats: ['DD/MM/YYYY', 'D/M/YYYY'] },
        { separator: '-', yearLen: 4, formats: ['DD-MM-YYYY'] },
        { separator: '.', yearLen: 2, formats: ['DD.MM.YY'] },
      ];
      const namedFormats = ['D Mon YYYY', 'Mon D, YYYY', 'DD Mon YYYY'];

      const proofs = ctx.rng.shuffle(rowIndexes.filter((index) => dayOf(index) > 12));
      const used = new Set<number>();

      for (const shape of shapes) {
        const carrier = proofs.find((index) => !used.has(index));
        if (carrier === undefined) continue; // no proof exists for this shape
        used.add(carrier);
        ctx.rows[carrier][column] = renderDate(
          String(ctx.gt.rows[carrier][column]),
          ctx.rng.pick(shape.formats),
        );
      }

      for (const rowIndex of rowIndexes) {
        if (used.has(rowIndex)) continue;
        const numeric = ctx.rng.chance(0.7);
        let format: string;
        if (numeric) {
          const shape = ctx.rng.pick(shapes);
          format = ctx.rng.pick(shape.formats);
        } else {
          format = ctx.rng.pick(namedFormats);
        }
        ctx.rows[rowIndex][column] = renderDate(String(ctx.gt.rows[rowIndex][column]), format);
      }
    }
  },
};

/** Indian lakh grouping: 12,34,567.89 (and plain 1,234,567.89). */
function lakhGroup(value: number, indian: boolean): string {
  const [wholeRaw, decimals] = value.toFixed(2).split('.');
  const negative = wholeRaw.startsWith('-');
  const whole = negative ? wholeRaw.slice(1) : wholeRaw;
  let grouped: string;
  if (indian && whole.length > 3) {
    const head = whole.slice(0, -3);
    const tail = whole.slice(-3);
    const pairs = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${pairs},${tail}`;
  } else if (whole.length > 3) {
    grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  } else {
    grouped = whole;
  }
  return `${negative ? '-' : ''}${grouped}.${decimals}`;
}

const currencyInjector: Injector = {
  name: 'currency',
  phase: 'value',
  apply(ctx) {
    const idColumns = new Set(ofKind(ctx, 'id'));
    const targets = ofKind(ctx, 'number').filter((index) => !idColumns.has(index));
    for (const column of targets) {
      const at = ctx.position[column];
      if (at < 0) continue;
      ctx.rows.forEach((row) => {
        const cell = row[at];
        if (typeof cell !== 'number' || !ctx.rng.chance(0.6)) return;
        const variant = ctx.rng.int(0, 4);
        if (variant === 0) row[at] = `₹${lakhGroup(cell, true)}`;
        else if (variant === 1) row[at] = `Rs. ${lakhGroup(cell, false)}`;
        else if (variant === 2) row[at] = `INR ${cell.toFixed(2)}`;
        else if (variant === 3) row[at] = lakhGroup(cell, true);
        // variant 4 stays a plain number
      });
    }
  },
};

const textInNumeric: Injector = {
  name: 'text in numeric',
  phase: 'value',
  apply(ctx) {
    const ids = new Set(ofKind(ctx, 'id'));
    const poison = ['N/A', 'pending', 'included'];
    const targets = ofKind(ctx, 'number').filter((index) => !ids.has(index));
    for (const column of targets) {
      const at = ctx.position[column];
      if (at < 0) continue;
      ctx.rows.forEach((row, rowIndex) => {
        if (typeof row[at] !== 'number' || !ctx.rng.chance(0.08)) return;
        row[at] = ctx.rng.pick(poison);
        // The pipeline must end with null here; the note column is extra.
        ctx.expected[rowIndex][column] = null;
      });
    }
  },
};

const NUMBER_WORDS: Record<number, string> = {
  0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six',
  7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve',
  13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen', 17: 'seventeen',
  18: 'eighteen', 19: 'nineteen', 20: 'twenty', 30: 'thirty', 40: 'forty',
  50: 'fifty', 60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety',
};

function spell(value: number): string | null {
  if (value < 0 || value > 999) return null;
  if (value >= 100) {
    // "two hundred nine", "five hundred forty six" – R13 parses `hundred`.
    const head = Math.floor(value / 100);
    const rest = value % 100;
    const hundred = `${NUMBER_WORDS[head]} hundred`;
    if (rest === 0) return hundred;
    if (rest < 20 || rest % 10 === 0) return `${hundred} ${NUMBER_WORDS[rest]}`;
    return `${hundred} ${NUMBER_WORDS[Math.floor(rest / 10) * 10]} ${NUMBER_WORDS[rest % 10]}`;
  }
  if (value < 20 || value % 10 === 0) return NUMBER_WORDS[value] ?? null;
  const tens = Math.floor(value / 10) * 10;
  const rest = value % 10;
  return `${NUMBER_WORDS[tens]} ${NUMBER_WORDS[rest]}`;
}

const spelledOut: Injector = {
  name: 'spelled numbers',
  phase: 'value',
  apply(ctx) {
    const ids = new Set(ofKind(ctx, 'id'));
    const targets = ofKind(ctx, 'number').filter((index) => !ids.has(index));
    for (const column of targets) {
      const at = ctx.position[column];
      if (at < 0) continue;
      ctx.rows.forEach((row) => {
        const cell = row[at];
        if (typeof cell !== 'number' || !Number.isInteger(cell) || !ctx.rng.chance(0.5)) return;
        const word = spell(cell);
        if (word === null) return;
        row[at] = ctx.rng.chance(0.5) ? word.toUpperCase() : word;
      });
    }
  },
};

const prefixIds: Injector = {
  name: 'prefixed ids',
  phase: 'value',
  apply(ctx) {
    const ids = ofKind(ctx, 'id');
    if (ids.length === 0) return;
    const at = ctx.position[ids[0]];
    if (at < 0) return;
    const prefixes = ['#', 'ORD-', 'ID ', '', '  '];
    ctx.rows.forEach((row) => {
      if (typeof row[at] !== 'number') return;
      if (ctx.rng.chance(0.7)) row[at] = `${ctx.rng.pick(prefixes)}${row[at]}`;
    });
  },
};

const missingIds: Injector = {
  name: 'missing ids',
  phase: 'value',
  apply(ctx) {
    const ids = ofKind(ctx, 'id');
    if (ids.length === 0) return;
    const column = ids[0];
    const at = ctx.position[column];
    if (at < 0) return;
    // Any present cell may hold the id (earlier value-phase injectors can
    // rewrite it to a string: prefixes, quotes, currency) – blank those too,
    // otherwise the injection silently no-ops and R14 never gets a gap to see.
    ctx.rows.forEach((row, rowIndex) => {
      const cell = row[at];
      if (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '')) return;
      if (ctx.rng.chance(0.14)) {
        row[at] = null;
        ctx.expected[rowIndex][column] = null;
      }
    });
  },
};

const ITEM_WORDS = ['priority', 'gift wrap', 'rush handling', 'insurance', 'extra padding'];

const multiItem: Injector = {
  name: 'multi item',
  phase: 'value',
  apply(ctx) {
    const columns = cleanTextColumns(ctx).filter((index) => ctx.position[index] >= 0);
    if (columns.length === 0) return;
    const column = ctx.rng.pick(columns);
    const at = ctx.position[column];
    ctx.rows.forEach((row, rowIndex) => {
      const cell = row[at];
      if (typeof cell !== 'string' || cell.trim() === '' || !ctx.rng.chance(0.4)) return;
      const text = `${cell}; ${ctx.rng.pick(ITEM_WORDS)}`;
      row[at] = text;
      ctx.expected[rowIndex][column] = text;
    });
  },
};

const overlappingCategory: Injector = {
  name: 'overlapping category',
  phase: 'value',
  apply(ctx) {
    const categories = ofKind(ctx, 'text').filter((index) => {
      if (ctx.position[index] < 0) return false;
      const keys = new Set(
        ctx.gt.rows.map((row) => String(row[index] ?? '').toLowerCase()).filter(Boolean),
      );
      return keys.size >= 3 && keys.size <= 10 && ctx.gt.rows.every((row) => row[index] !== null);
    });
    if (categories.length === 0) return;
    const column = ctx.rng.pick(categories);
    const distinct = [...new Set(ctx.gt.rows.map((row) => String(row[column])))];
    if (distinct.length < 2) return;
    const [first, second] = ctx.rng.shuffle(distinct);
    const at = ctx.position[column];
    let replaced = 0;
    ctx.rows.forEach((row, rowIndex) => {
      const cell = row[at];
      if (typeof cell !== 'string' || !ctx.rng.chance(0.25)) return;
      const text = `${first} / ${second}`;
      row[at] = text;
      ctx.expected[rowIndex][column] = text;
      replaced += 1;
    });
    if (replaced > 0) {
      ctx.overlapColumns.add(column);
      ctx.expect.overlap = true;
    }
  },
};

// ------------------------------------------------------------- columns phase ---

const packedKv: Injector = {
  name: 'key=value packed',
  phase: 'columns',
  apply(ctx) {
    const idColumns = new Set(ofKind(ctx, 'id'));
    const candidates = ofKind(ctx, 'text')
      .concat(
        ofKind(ctx, 'number').filter((index) =>
          ctx.gt.rows.every((row) => row[index] === null || typeof row[index] === 'number'),
        ),
      )
      .filter((index) => {
        if (ctx.position[index] < 0 || idColumns.has(index)) return false;
        const header = ctx.gt.header[index];
        if (header.length > 30 || !/^[A-Za-z]/.test(header)) return false;
        // A ';' inside a value would break the packing; check the real content.
        return ctx.rows.every((row) => {
          const cell = row[ctx.position[index]];
          return cell === null || !String(cell).includes(';');
        });
      });
    if (candidates.length < 2) return;

    const chosen = ctx.rng.pickMany(candidates, Math.min(candidates.length, ctx.rng.int(2, 3)));
    chosen.sort((a, b) => a - b);
    const target = chosen[0];

    const packed = (row: Cell[]): Cell => {
      const parts: string[] = [];
      for (const gtIndex of chosen) {
        const cell = row[ctx.position[gtIndex]];
        if (cell === null || cell === undefined || cell === '') continue;
        parts.push(`${ctx.gt.header[gtIndex]}=${String(cell)}`);
      }
      return parts.length === 0 ? null : parts.join('; ');
    };

    ctx.rows = ctx.rows.map((row) => {
      row[target] = packed(row);
      return row;
    });
    for (const gtIndex of chosen.slice(1)) dropColumn(ctx, gtIndex);
    ctx.header[target] = 'Details';
  },
};

const pairComposite: Injector = {
  name: 'A / B composite',
  phase: 'columns',
  apply(ctx) {
    const usable = cleanTextColumns(ctx, true).filter(
      (index) => ctx.position[index] >= 0 && !ctx.overlapColumns.has(index),
    );
    if (usable.length < 2) return;
    const [first, second] = ctx.rng.shuffle(usable).slice(0, 2);
    const lo = Math.min(first, second);
    const hi = Math.max(first, second);
    const separator = ctx.rng.chance(0.5) ? ' / ' : ' - ';
    const atLo = ctx.position[lo];
    const atHi = ctx.position[hi];

    ctx.header[atLo] = `${ctx.header[atLo]}${separator}${ctx.header[atHi]}`;
    ctx.rows.forEach((row) => {
      const left = row[atLo];
      const right = row[atHi];
      row[atLo] = left === null || right === null ? null : `${String(left)}${separator}${String(right)}`;
    });
    dropColumn(ctx, hi);
  },
};

const parenQualifier: Injector = {
  name: 'paren qualifier',
  phase: 'columns',
  apply(ctx) {
    // Structural separators inside the CURRENT cells (a column merge's "A / B",
    // key=value packing, multi-item `;`) hand the column to R5 first, so the
    // R16 expectation (col → col_base + col_qualifier) could never hold.
    // Only pick cells R16 can own outright – same criteria cleanTextColumns
    // applies to ground truth, but checked against the messy cells themselves.
    const structuralCell = (value: Cell): boolean => {
      const text = String(value);
      return /[();=]/.test(text) || /\s[-–—]\s/.test(text) || /\s\/\s/.test(text);
    };
    const usable = cleanTextColumns(ctx, false).filter((index) => {
      const at = ctx.position[index];
      if (at < 0 || ctx.overlapColumns.has(index) || ctx.mergedColumns.has(index)) return false;
      return ctx.rows.every((row) => {
        const cell = row[at];
        return cell === null || cell === undefined || !structuralCell(cell);
      });
    });
    if (usable.length === 0) return;
    const column = ctx.rng.pick(usable);
    const qualifiers = ['primary', 'secondary', 'standard', 'urgent', 'backup'];
    const at = ctx.position[column];
    ctx.rows.forEach((row) => {
      const cell = row[at];
      if (typeof cell !== 'string' || cell.trim() === '') return;
      row[at] = `${cell} (${ctx.rng.pick(qualifiers)})`;
    });
    ctx.parenColumns.add(column);
    ctx.colName.set(column, `${ctx.colName.get(column) ?? toSnakeCase(ctx.gt.header[column])}_base`);
  },
};

// ---------------------------------------------------------------- rows phase ---

const conflictingDuplicates: Injector = {
  name: 'conflicting duplicates',
  phase: 'rows',
  apply(ctx) {
    const excluded = (index: number): boolean =>
      ctx.position[index] < 0 ||
      ctx.mergedColumns.has(index) ||
      ctx.parenColumns.has(index) ||
      ctx.overlapColumns.has(index);

    const numeric = ofKind(ctx, 'number').filter((index) => !excluded(index));
    const text = cleanTextColumns(ctx).filter((index) => !excluded(index));
    const copies = ctx.rng.int(1, 2);

    for (let i = 0; i < copies; i += 1) {
      const source = ctx.rng.int(0, ctx.rows.length - 1);
      const useNumeric = numeric.length > 0 && ctx.rng.chance(0.7);
      const pool = useNumeric ? numeric : text;
      if (pool.length === 0) continue;
      const column = ctx.rng.pick(pool);
      const at = ctx.position[column];
      const cell = ctx.rows[source][at];
      if (useNumeric) {
        if (typeof cell !== 'number') continue;
        const changed = Math.round((cell + 7) * 100) / 100;
        ctx.rows.splice(source + 1, 0, [...ctx.rows[source]]);
        ctx.expected.splice(source + 1, 0, [...ctx.expected[source]]);
        ctx.rows[source + 1][at] = changed;
        ctx.expected[source + 1][column] = changed;
      } else {
        if (typeof cell !== 'string') continue;
        const changed = `${cell} (edited)`;
        ctx.rows.splice(source + 1, 0, [...ctx.rows[source]]);
        ctx.expected.splice(source + 1, 0, [...ctx.expected[source]]);
        ctx.rows[source + 1][at] = changed;
        ctx.expected[source + 1][column] = changed;
      }
      ctx.netRowAdds += 1;
    }
  },
};

const exactDuplicates: Injector = {
  name: 'exact duplicates',
  phase: 'rows',
  apply(ctx) {
    const copies = ctx.rng.int(1, 3);
    for (let i = 0; i < copies; i += 1) {
      const source = ctx.rng.int(0, ctx.rows.length - 1);
      ctx.rows.splice(source + 1, 0, [...ctx.rows[source]]);
      ctx.expected.splice(source + 1, 0, [...ctx.expected[source]]);
    }
  },
};

const preamble: Injector = {
  name: 'preamble',
  phase: 'rows',
  apply(ctx) {
    ctx.preamble.push(
      ['Quarterly Operations Report'],
      ['Export Date: 2027-01-01'],
      [''],
    );
  },
};

const footer: Injector = {
  name: 'footer',
  phase: 'rows',
  apply(ctx) {
    ctx.footer.push(
      [''],
      [`Total rows: ${ctx.gt.rows.length + ctx.netRowAdds}`],
      ['Prepared by: Automated Export'],
      ['Generated on 2027-01-01 06:00'],
      ['END'],
      ['Trailing note after the end marker'],
    );
    ctx.expect.rowCountControl = true;
  },
};

const blankRows: Injector = {
  name: 'blank rows',
  phase: 'rows',
  apply(ctx) {
    const blank = (): Cell[] => Array.from({ length: ctx.header.length }, () => '');
    for (let i = 0; i < 3; i += 1) {
      const at = ctx.rng.int(0, ctx.rows.length);
      ctx.rows.splice(at, 0, blank());
      ctx.expected.splice(at, 0, blank());
    }
    ctx.preamble.push(blank());
  },
};

// ---------------------------------------------------------------- file phase ---

const delimiterInjector: Injector = {
  name: 'delimiter',
  phase: 'file',
  apply(ctx) {
    ctx.delimiter = ctx.rng.pick([';', '\t', '|']);
  },
};

const bomNewlines: Injector = {
  name: 'bom + newline mix',
  phase: 'file',
  apply(ctx) {
    ctx.bom = true;
    ctx.mixedNewlines = true;
  },
};

export const INJECTORS: Injector[] = [
  caseInjector,
  whitespaceInjector,
  quotesInjector,
  mixedDates,
  currencyInjector,
  textInNumeric,
  spelledOut,
  prefixIds,
  missingIds,
  multiItem,
  overlappingCategory,
  packedKv,
  pairComposite,
  parenQualifier,
  conflictingDuplicates,
  exactDuplicates,
  preamble,
  footer,
  blankRows,
  delimiterInjector,
  bomNewlines,
];

/** The fixed phase order combinations are applied in. */
export const PHASES: InjectorPhase[] = ['value', 'columns', 'rows', 'file'];

// --------------------------------------------------------------- serializer ---

export function escapeCell(value: Cell, delimiterChar: string): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text.includes(delimiterChar) || text.includes('"') || text.includes('\n')
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

export function lineOf(cells: Cell[], delimiterChar: string): string {
  return cells.map((cell) => escapeCell(cell, delimiterChar)).join(delimiterChar);
}

/** Build the messy file exactly as a user would export it. */
export function serialize(ctx: InjectContext): string {
  const delimiterChar = ctx.delimiter ?? ',';
  const lines: string[] = [];
  for (const row of ctx.preamble) lines.push(lineOf(row, delimiterChar));
  lines.push(lineOf(ctx.header as unknown as Cell[], delimiterChar));
  for (const row of ctx.rows) lines.push(lineOf(row, delimiterChar));
  for (const row of ctx.footer) lines.push(lineOf(row, delimiterChar));

  const text = ctx.mixedNewlines
    ? lines.map((line, index) => (index % 2 === 0 ? `${line}\r\n` : `${line}\n`)).join('')
    : lines.join('\n');
  return ctx.bom ? `\uFEFF${text}` : text;
}
