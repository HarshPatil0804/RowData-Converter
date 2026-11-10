/** A single cell value after cleaning. */
export type Cell = string | number | boolean | null;

export type ColumnType = 'number' | 'date' | 'boolean' | 'text';

/** Aggregations supported by the pivot builder. */
export type Aggregation = 'sum' | 'count' | 'avg' | 'min' | 'max';

/** A table that has rows/columns but has not been cleaned yet. */
export interface RawTable {
  columns: string[];
  rows: Cell[][];
  /**
   * true  → the first row was recognised as a header by the extractor
   * false → every row is data
   * null  → unknown; the cleaning stage decides
   */
  hasHeader: boolean | null;
  /** Human readable label of how the data was obtained, e.g. "CSV · delimiter ','". */
  strategy: string;
  notes: string[];
  /**
   * S4 – lines the reader itself refused as table rows (banner, export date,
   * delimiter padding, error / summary / footer lines). They are rejected rows
   * with a reason, never silently dropped.
   */
  rejectedRows?: RejectedRow[];
}

/** Intermediate output of every extractor. */
export type Extraction =
  | {
      kind: 'table';
      source: string;
      columns: string[];
      rows: Cell[][];
      /** true when the extractor pulled a real header row out of the source. */
      hasHeader?: boolean;
      strategy: string;
      notes: string[];
      /** S4 – lines that did not fit the structure found in the content. */
      rejectedRows?: RejectedRow[];
    }
  | { kind: 'records'; source: string; records: Record<string, Cell>[]; strategy: string; notes: string[] }
  | { kind: 'text'; source: string; text: string; strategy: string; notes: string[] };

/**
 * R1 – a row pulled out of the data before cleaning, kept with the reason it
 * was rejected. Rejected rows are never deleted silently: they are shown in
 * the "Rejected rows" table and exported with the workbook.
 */
export interface RejectedRow {
  /** Machine readable reason, e.g. "error row", "summary/total line". */
  reason: string;
  /** The row exactly as it was parsed. */
  values: Cell[];
}

/**
 * A low-confidence decision (principle 2): the original value is kept, the
 * change is flagged, and "Needs review" offers the suggested fix with
 * Accept/Reject. Accepting re-runs the pipeline with the suggestion applied.
 */
export interface ReviewItem {
  /** Stable id, e.g. "date_order:visit_date:numeric-/-4" or "value_fill:city". */
  id: string;
  kind:
    | 'date_order'
    | 'value_fill'
    | 'missing_id'
    | 'overlap'
    | 'packed_split'
    | 'serial_dates'
    | 'parse_gap'
    | 'similar_values'
    | 'table_split';
  /** Column the decision belongs to. */
  column: string;
  /** Row the decision belongs to (null = whole column). */
  rowIndex: number | null;
  /** The original value ("" when the cell was empty). */
  original: string;
  /** The fix the pipeline suggests but has not applied (unless `applied`). */
  suggested: string;
  /** 0…1 – below 0.8 the item is shown for review. */
  confidence: number;
  reason: string;
  /** true when the suggestion was already applied to the data. */
  applied: boolean;
}

/** R15 – a "Total rows/records: N" control line compared with the clean rows. */
export interface RowControl {
  reported: number;
  actual: number;
  matches: boolean;
  source: string;
}

/** R18 – a value that overlaps other values of the same column. */
export interface OverlapEntry {
  column: string;
  value: string;
  /** The standalone values contained in `value`. */
  parts: string[];
}

/** R6 – one before → after value normalisation, kept for the report. */
export interface ValueMapping {
  column: string;
  from: string;
  to: string;
  /** How many cells carried `from`. */
  count: number;
}

/** R10 – the parsed total compared with the total reported in the file. */
export interface Reconciliation {
  /** Column whose values were summed. */
  column: string;
  /** Sum of the parsed column. */
  parsed: number;
  /** Total read from the file's summary/total line, when there is one. */
  reported: number | null;
  /** parsed − reported (null when there is nothing to compare). */
  difference: number | null;
  /** The raw summary line the reported total came from. */
  source: string | null;
  /** true when the two agree within a cent, null when unverifiable. */
  matches: boolean | null;
}

export interface ColumnMeta {
  name: string;
  type: ColumnType;
  /** Missing values after sentinel normalisation. */
  nulls: number;
  /** Missing values filled with the column mode (text columns only, small gaps). */
  filled: number;
  unique: number;
  /** IQR outliers that were flagged but never removed. */
  outliers: number;
  /** Values converted into the column type (dates → ISO, numbers, categories). */
  conversions: number;
  examples: Cell[];
}

export interface FileReport {
  fileName: string;
  sourceType: string;
  strategy: string;
  rowsIn: number;
  rowsOut: number;
  columnsIn: number;
  columnsOut: number;
  duplicatesRemoved: number;
  emptyRowsDropped: number;
  emptyColumnsDropped: number;
  /** Sentinel strings ("N/A", "-", "null"…) converted to real nulls. */
  nullsFixed: number;
  /** Missing text values filled with the column mode. */
  valuesFilled: number;
  outliersFlagged: number;
  headerDetected: boolean;
  generatedHeaders: string[];
  /** R1 – rows moved to the "Rejected rows" table. */
  rejectedCount: number;
  /** R1 – rejection reasons with their counts. */
  rejectedReasons: { reason: string; count: number }[];
  /** R3 – number of date values whose day/month order could not be proven. */
  ambiguousDates: number;
  /** R9/R7 – flag columns with the number of rows they flag. */
  flagCounts: { name: string; count: number }[];
  /** R6 – before → after value normalisations. */
  mappings: ValueMapping[];
  /** R10 – parsed vs reported total. */
  reconciliation: Reconciliation | null;
  /** Text cells a spreadsheet would treat as a formula (exported prefixed). */
  spreadsheetSafeCells: number;
  /** R15 – row-count control line vs the number of clean rows. */
  rowControl: RowControl | null;
  /** Date found in the file's export/generated metadata line. */
  exportDate: string | null;
  /** Pipeline rules that actually did something for this file. */
  rulesFired: string[];
  /** Every automatic change with a confidence score (principle 2). */
  reviewItems: ReviewItem[];
  /** R13 – spelled-out numbers rewritten as digits. */
  spelledNumbers: number;
  /** R18 – values that contain other values of the same column. */
  overlapping: OverlapEntry[];
  /** T1 – per-column parse rate for typed columns (parsed / present). */
  parseRates: { column: string; parsed: number; total: number; rate: number }[];
  /** T2–T5, N1–N3 – what was rewritten into the column's type, and how much. */
  conversions: { column: string; kind: string; count: number }[];
  notes: string[];
}

export interface QualityReport extends FileReport {
  /** One entry per source file (zip entries count separately). */
  files: FileReport[];
  /** Columns produced by type inference and standardisation. */
  columns: ColumnMeta[];
}

export interface Dataset {
  columns: string[];
  types: ColumnType[];
  rows: Cell[][];
  /** R1 – rows set aside with the reason they were rejected. */
  rejected: RejectedRow[];
  /** Names of the flag columns present (R7 system flag + R9 logic flags). */
  flagColumns: string[];
  /** Low-confidence decisions waiting in the "Needs review" tab. */
  review: ReviewItem[];
  report: QualityReport;
}

export interface ProgressUpdate {
  /** 0…100 */
  pct: number;
  stage: 'detect' | 'extract' | 'structure' | 'clean' | 'report' | 'done';
  message: string;
}

export type PivotConfig = {
  rows: string[];
  cols: string[];
  value: string;
  agg: Aggregation;
};