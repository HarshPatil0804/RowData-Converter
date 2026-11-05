import { useMemo, useState, type ReactNode } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import type { Aggregation, ColumnType, Dataset, PivotConfig } from '../types';
import {
  computePivot,
  flaggedShares,
  suggestPivot,
  suggestPivots,
  verifyPivot,
  type PivotTable,
} from '../lib/pivot';
import { pivotToMatrix, pivotToSheets, downloadCSV, downloadXLSX } from '../lib/export';

export interface PivotViewProps {
  dataset: Dataset;
  onDownloaded: () => void;
  /** Shared with the tabular view: one switch for every CSV this screen writes. */
  spreadsheetSafe: boolean;
  onSpreadsheetSafeChange: (value: boolean) => void;
}

type Zone = 'rows' | 'cols' | 'values';

const AGGS: { value: Aggregation; label: string }[] = [
  { value: 'sum', label: 'Sum' },
  { value: 'count', label: 'Count' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
];

/** P7 – Indian grouping, two decimals, no currency symbol. */
const numberFormat = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function FieldChip({
  field,
  type,
  from,
  onRemove,
}: {
  field: string;
  type?: ColumnType;
  from?: Zone | 'palette';
  onRemove?: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `chip-${from ?? 'palette'}-${field}`,
    data: { field },
  });
  return (
    <span
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`field-chip ${isDragging ? 'field-chip-dragging' : ''}`}
    >
      {type && (
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${
            type === 'number'
              ? 'bg-cyan-500'
              : type === 'date'
                ? 'bg-fuchsia-500'
                : type === 'boolean'
                  ? 'bg-green-500'
                  : 'bg-slate-400'
          }`}
        />
      )}
      {field}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${field}`}
          className="muted hover:text-red-500 font-bold leading-none"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

function ZoneBox({
  id,
  label,
  children,
  hint,
}: {
  id: string;
  label: string;
  children: ReactNode;
  hint: string;
}) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div>
      <div className="text-[0.7rem] font-bold uppercase tracking-wide muted mb-1">{label}</div>
      <div ref={setNodeRef} className={`drop-zone-box ${isOver ? 'drop-zone-box-over' : ''}`}>
        {children}
        {Array.isArray(children) && children.length === 0 && (
          <span className="muted text-xs px-1">{hint}</span>
        )}
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="muted text-xs flex items-center gap-2 cursor-pointer select-none" title={hint}>
      <input
        type="checkbox"
        className="accent-indigo-600"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

/** One pivot grid: header, body, bold Total row, Total column. */
function PivotGrid({
  pivot,
  showZero,
  includeTotals,
  headerPrefix = [],
}: {
  pivot: PivotTable;
  showZero: boolean;
  includeTotals: boolean;
  headerPrefix?: string[];
}) {
  const cellText = (value: number | null): string => {
    if (value === null || !Number.isFinite(value)) return showZero ? numberFormat.format(0) : '—';
    return numberFormat.format(value);
  };

  return (
    <div className="grid-scroll">
      <table className="grid-table">
        <thead>
          <tr>
            {(pivot.rowFields.length > 0 ? pivot.rowFields : ['Rows']).map((field) => (
              <th key={field}>{field}</th>
            ))}
            {pivot.columns.map((column) => (
              <th key={column} className="text-right">
                {column}
              </th>
            ))}
            {includeTotals && <th className="text-right">Total</th>}
            {headerPrefix.map((field) => (
              <th key={field} className="text-right">
                {field}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pivot.rowLabels.map((labels, rowIndex) => (
            <tr key={labels.join('|') || `row-${rowIndex}`}>
              {labels.map((label, labelIndex) => (
                <td key={`${label}-${labelIndex}`}>{label}</td>
              ))}
              {pivot.cells[rowIndex].map((value, columnIndex) => (
                <td key={columnIndex} className="text-right mono-num">
                  {value === null && !showZero ? (
                    <span className="text-slate-300 dark:text-slate-600">—</span>
                  ) : (
                    cellText(value)
                  )}
                </td>
              ))}
              {includeTotals && (
                <td className="text-right mono-num font-bold">
                  {cellText(pivot.rowTotals[rowIndex])}
                </td>
              )}
            </tr>
          ))}
          {includeTotals && (
            <tr className="font-bold bg-slate-50 dark:bg-slate-900">
              <td>Total</td>
              {pivot.rowFields.slice(1).map((field) => (
                <td key={field} />
              ))}
              {pivot.colTotals.map((value, index) => (
                <td key={index} className="text-right mono-num">
                  {cellText(value)}
                </td>
              ))}
              <td className="text-right mono-num">{cellText(pivot.grandTotal)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function PivotView({
  dataset,
  onDownloaded,
  spreadsheetSafe,
  onSpreadsheetSafeChange,
}: PivotViewProps) {
  const [config, setConfig] = useState<PivotConfig>(() => suggestPivot(dataset));
  const [showZero, setShowZero] = useState(false); // P3, default off
  const [includeTotals, setIncludeTotals] = useState(true); // P5 CSV option, default on
  const [excludeFlagged, setExcludeFlagged] = useState(false); // P6, default off
  const [showCountView, setShowCountView] = useState(false); // P4 Sum + Count
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const typeIndex = useMemo(() => {
    const map = new Map<string, ColumnType>();
    dataset.columns.forEach((name, index) => map.set(name, dataset.types[index]));
    return map;
  }, [dataset]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // P6 – the flag carrying the largest share of the current total.
  const shares = useMemo(() => flaggedShares(dataset, config), [dataset, config]);
  const primaryShare = shares.length > 0 ? shares[0] : null;
  const activeFlag = excludeFlagged && primaryShare ? primaryShare.flag : null;

  const pivot: PivotTable = useMemo(() => {
    const effective: PivotConfig = { ...config };
    if (effective.value && typeIndex.get(effective.value) !== 'number' && effective.agg !== 'count') {
      effective.agg = 'count';
    }
    if (!effective.value) effective.agg = 'count';
    return computePivot(dataset, effective, { excludeFlag: activeFlag });
  }, [dataset, config, typeIndex, activeFlag]);

  /** P4 – a second grid counting the rows behind each cell. */
  const countPivot: PivotTable | null = useMemo(() => {
    if (!showCountView || !config.value) return null;
    return computePivot(dataset, { rows: config.rows, cols: config.cols, value: config.value, agg: 'count' }, {
      excludeFlag: activeFlag,
    });
  }, [showCountView, dataset, config, activeFlag]);

  // P5 – verify before any download is allowed.
  const verification = useMemo(() => verifyPivot(pivot), [pivot]);

  // P9 – top-2 suggestions.
  const suggestions = useMemo(() => suggestPivots(dataset), [dataset]);

  const assigned = new Set([...config.rows, ...config.cols, ...(config.value ? [config.value] : [])]);
  const palette = dataset.columns.filter((name) => !assigned.has(name));

  const moveField = (field: string, zone: Zone) => {
    setConfig((previous) => {
      const rows = previous.rows.filter((name) => name !== field);
      const cols = previous.cols.filter((name) => name !== field);
      const value = previous.value === field ? '' : previous.value;
      if (zone === 'values') return { ...previous, rows, cols, value: field };
      if (zone === 'rows') return { ...previous, rows: [...rows, field], cols, value };
      return { ...previous, rows, cols: [...cols, field], value };
    });
  };

  const unassign = (field: string) => {
    setConfig((previous) => ({
      ...previous,
      rows: previous.rows.filter((name) => name !== field),
      cols: previous.cols.filter((name) => name !== field),
      value: previous.value === field ? '' : previous.value,
    }));
  };

  const onDragEnd = (event: DragEndEvent) => {
    const field = event.active.data.current?.field as string | undefined;
    const overId = event.over?.id as string | undefined;
    if (!field) return;
    if (overId && overId.startsWith('zone-')) {
      moveField(field, overId.slice(5) as Zone);
    } else if (overId === 'palette') {
      unassign(field);
    }
  };

  const { setNodeRef: paletteRef, isOver: paletteOver } = useDroppable({ id: 'palette' });

  const matrixOptions = { includeTotals, showZero };

  const downloadPivotCsv = () => {
    if (!verification.ok) {
      setDownloadError(`Download blocked — totals do not reconcile: ${verification.failures[0]}`);
      return;
    }
    setDownloadError(null);
    const { columns, rows } = pivotToMatrix(pivot, matrixOptions);
    // Pivot cells mix labels and totals, so no column type is declared: the
    // writer falls back to "text unless the cell is a plain number", which
    // leaves every real total (including negatives) untouched.
    downloadCSV(columns, rows, 'pivot.csv', { spreadsheetSafe });
    onDownloaded();
  };

  const downloadPivotXlsx = () => {
    if (!verification.ok) {
      setDownloadError(`Download blocked — totals do not reconcile: ${verification.failures[0]}`);
      return;
    }
    setDownloadError(null);
    downloadXLSX(pivotToSheets(dataset, pivot, matrixOptions), 'pivot.xlsx');
    onDownloaded();
  };

  const valueType = config.value ? typeIndex.get(config.value) : undefined;
  const excludedRows = pivot.totalRows - pivot.rowsWithoutValue - pivot.rowsExcludedFlagged;

  return (
    <div className="flex flex-col gap-4">
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="card p-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-sm">Pivot builder</h3>
              <p className="muted text-xs">Drag fields into Rows, Columns and Values — or drop them back on the field list.</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="muted text-xs flex items-center gap-2">
                Aggregation
                <select
                  className="input"
                  value={config.agg}
                  onChange={(event) => setConfig({ ...config, agg: event.target.value as Aggregation })}
                  aria-label="Aggregation"
                >
                  {AGGS.map((agg) => (
                    <option key={agg.value} value={agg.value}>
                      {agg.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn btn-ghost" onClick={() => setConfig(suggestPivot(dataset))}>
                Reset suggestion
              </button>
            </div>
          </div>

          {/* P9 – top-2 default pivots */}
          {suggestions.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-xs muted">
              <span className="font-semibold">Suggestions:</span>
              {suggestions.map((suggestion, index) => (
                <button
                  key={`${suggestion.rows.join()}-${suggestion.cols.join()}`}
                  className={`btn btn-ghost text-xs ${
                    suggestion.rows.join() === config.rows.join() &&
                    suggestion.cols.join() === config.cols.join() &&
                    suggestion.value === config.value
                      ? 'border-indigo-500'
                      : ''
                  }`}
                  onClick={() => setConfig(suggestion)}
                >
                  {index + 1}. {suggestion.rows.join(', ') || '—'}
                  {suggestion.cols.length > 0 ? ` × ${suggestion.cols.join(', ')}` : ''}
                  {suggestion.value ? ` → ${suggestion.agg}(${suggestion.value})` : ''}
                </button>
              ))}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-3">
            <ZoneBox id="zone-rows" label="Rows" hint="Drag a field here">
              {config.rows.map((field) => (
                <FieldChip
                  key={field}
                  field={field}
                  type={typeIndex.get(field)}
                  from="rows"
                  onRemove={() => unassign(field)}
                />
              ))}
            </ZoneBox>
            <ZoneBox id="zone-cols" label="Columns" hint="Drag a field here">
              {config.cols.map((field) => (
                <FieldChip
                  key={field}
                  field={field}
                  type={typeIndex.get(field)}
                  from="cols"
                  onRemove={() => unassign(field)}
                />
              ))}
            </ZoneBox>
            <ZoneBox id="zone-values" label="Values" hint="Drag a field here">
              {config.value ? (
                <FieldChip
                  field={config.value}
                  type={typeIndex.get(config.value)}
                  from="values"
                  onRemove={() => unassign(config.value)}
                />
              ) : (
                []
              )}
            </ZoneBox>
          </div>

          <div ref={paletteRef} className={`drop-zone-box ${paletteOver ? 'drop-zone-box-over' : ''}`}>
            {palette.length === 0 ? (
              <span className="muted text-xs px-1">All fields are in use — drop a chip here to release it.</span>
            ) : (
              palette.map((field) => (
                <FieldChip key={field} field={field} type={typeIndex.get(field)} from="palette" />
              ))
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="muted text-xs">
              {config.value ? (
                <>
                  <span className="font-semibold text-slate-700 dark:text-slate-300">
                    {AGGS.find((agg) => agg.value === config.agg)?.label} of {config.value}
                  </span>
                  {' · '}
                  {valueType !== 'number' && config.agg !== 'count'
                    ? 'non-numeric value field – counting rows instead'
                    : `${dataset.rows.length.toLocaleString()} source rows`}
                </>
              ) : (
                `Counting rows · ${dataset.rows.length.toLocaleString()} source rows`
              )}
            </p>
            {/* P3 / P4 / P5 / P6 toggles */}
            <div className="flex flex-wrap items-center gap-4">
              <Toggle
                checked={showZero}
                onChange={setShowZero}
                label="Show 0 for empty cells"
                hint="P3 – off by default: an empty cell means no records, a 0 means the records summed to zero"
              />
              <Toggle
                checked={includeTotals}
                onChange={setIncludeTotals}
                label="Include totals"
                hint="P5 – adds the Total row and Total column to CSV/XLSX output (default on)"
              />
              <Toggle
                checked={showCountView}
                onChange={setShowCountView}
                label="Sum + Count"
                hint="P4 – show a second pivot of row counts so hidden rows become visible"
              />
              {primaryShare && (
                <Toggle
                  checked={excludeFlagged}
                  onChange={setExcludeFlagged}
                  label="Exclude flagged rows"
                  hint={`P6 – rebuilds the pivot without rows flagged: ${primaryShare.flag}`}
                />
              )}
            </div>
          </div>
        </div>
      </DndContext>

      {/* P4 – rows with no value, P6 – flagged share */}
      {(pivot.rowsWithoutValue > 0 || primaryShare) && (
        <div className="flex flex-col gap-2">
          {pivot.rowsWithoutValue > 0 && (
            <div
              className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
              role="status"
            >
              {pivot.rowsWithoutValue} of {pivot.totalRows.toLocaleString()} rows have no value and are not
              included in this sum.
              {!showCountView && config.value && (
                <button className="btn btn-ghost text-xs ml-2 underline" onClick={() => setShowCountView(true)}>
                  Show Sum + Count
                </button>
              )}
            </div>
          )}
          {primaryShare && (
            <div
              className={`rounded-xl border px-3 py-2 text-xs ${
                excludeFlagged
                  ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-800 dark:text-indigo-200'
                  : 'border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 muted'
              }`}
              role="status"
            >
              {(primaryShare.share * 100).toFixed(1)}% of this total comes from rows flagged:{' '}
              <span className="font-semibold">{primaryShare.flag}</span>
              {excludeFlagged && activeFlag && (
                <span className="ml-1">— excluded, {pivot.rowsExcludedFlagged} row(s) removed.</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* P5 – verification gate */}
      {!verification.ok && (
        <div className="rounded-xl border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300" role="alert">
          <span className="font-semibold">Totals do not reconcile — download disabled.</span>
          <ul className="list-disc pl-5 mt-1">
            {verification.failures.slice(0, 4).map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        </div>
      )}
      {downloadError && (
        <div className="rounded-xl border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300" role="alert">
          {downloadError}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 border-b border-[var(--u2s-border)]">
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={downloadPivotCsv}
              disabled={!verification.ok}
            >
              Download CSV
            </button>
            <button
              className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={downloadPivotXlsx}
              disabled={!verification.ok}
            >
              Download XLSX
            </button>
            <label
              className="btn btn-ghost inline-flex cursor-pointer items-center gap-2"
              title="A cell starting with = + - @ is a live formula in Excel. Prefixing it with an apostrophe keeps it as text. Trade-off: a label like -pending shows the quote in some viewers. Numeric totals are never changed."
            >
              <input
                type="checkbox"
                checked={spreadsheetSafe}
                onChange={(event) => onSpreadsheetSafeChange(event.target.checked)}
                className="h-4 w-4 accent-indigo-600"
              />
              Spreadsheet-safe export
            </label>
          </div>
          <span className="muted text-xs">
            {pivot.rowLabels.length.toLocaleString()} × {pivot.columns.length || 1} pivot grid
            {verification.ok ? ' · totals verified' : ''}
          </span>
        </div>

        <PivotGrid pivot={pivot} showZero={showZero} includeTotals={includeTotals} />

        {countPivot && (
          <div className="border-t border-[var(--u2s-border)]">
            <div className="px-3 py-2 text-xs font-semibold muted bg-slate-50 dark:bg-slate-900/60">
              Count view — how many rows stand behind each cell (total{' '}
              {(countPivot.grandTotal ?? 0).toLocaleString()})
            </div>
            <PivotGrid pivot={countPivot} showZero={showZero} includeTotals={includeTotals} />
          </div>
        )}
      </div>

      <p className="muted text-xs">
        {excludedRows.toLocaleString()} of {pivot.totalRows.toLocaleString()} rows are included in this pivot.
        Totals are checked before every download (P5).
      </p>
    </div>
  );
}
