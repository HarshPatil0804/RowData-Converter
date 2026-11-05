import { useMemo, useState } from 'react';
import type { Dataset } from '../types';
import type { ResultItem } from '../App';
import type { DateOrderMode } from '../lib/dates';
import { datasetToSheets, downloadCSV, downloadJSON, downloadXLSX, downloadText, qualityToCSV } from '../lib/export';
import { suggestPivot } from '../lib/pivot';
import { displayCell } from '../lib/strings';
import TabularView from './TabularView';
import PivotView from './PivotView';
import QualityPanel from './QualityPanel';
import NeedsReview from './NeedsReview';

type Mode = 'preview' | 'tabular' | 'pivot' | 'review';

export interface ChoiceScreenProps {
  results: ResultItem[];
  activeIndex: number;
  onSelectFile: (index: number) => void;
  onDownloaded: () => void;
  onRestart: () => void;
  /** R3 – 'auto' keeps unproven dates; 'DM'/'MD' is the explicit toggle. */
  dateOrder: DateOrderMode;
  /** R3 – flipping it re-runs the pipeline on the loaded files. */
  onDateOrderChange: (order: DateOrderMode) => void;
  /** Principle 2 – accepting a Needs-review suggestion re-runs with it applied. */
  onAcceptReview: (id: string) => void;
}

function shortName(name: string): string {
  const parts = name.split(/[!/\\]/);
  const last = parts[parts.length - 1] || name;
  return last.length > 34 ? `${last.slice(0, 31)}…` : last;
}

export default function ChoiceScreen({
  results,
  activeIndex,
  onSelectFile,
  onDownloaded,
  onRestart,
  dateOrder,
  onDateOrderChange,
  onAcceptReview,
}: ChoiceScreenProps) {
  const [mode, setMode] = useState<Mode>('preview');
  /** R17 – Explode multi-item rows into a second sheet. Default off. */
  const [explode, setExplode] = useState(false);
  /**
   * Spreadsheet-safe export: prefix text cells a spreadsheet would evaluate as
   * a formula with an apostrophe. On by default, because the alternative is
   * handing a visitor a CSV that runs `=cmd|' /C calc'!A0` when they open it.
   */
  const [spreadsheetSafe, setSpreadsheetSafe] = useState(true);
  const active: Dataset = results[activeIndex]?.dataset ?? results[0].dataset;
  const report = active.report;

  // A sensible pivot axis pair for the preview card. Only the config is shown
  // here; PivotView computes its own table, so pivoting 500k rows eagerly just
  // blocked the main thread for nothing.
  const suggested = useMemo(() => suggestPivot(active), [active]);

  const hasItemCounts = active.columns.some((column) => column.endsWith('_item_count'));

  const downloadTabular = (kind: 'csv' | 'xlsx' | 'json') => {
    if (kind === 'csv') {
      downloadCSV(active.columns, active.rows, 'data.csv', { types: active.types, spreadsheetSafe });
    } else if (kind === 'json') downloadJSON(active.columns, active.rows, 'data.json');
    // XLSX text is always written as a string cell (never a formula), so the
    // toggle cannot change this file — nothing to branch on here.
    else downloadXLSX(datasetToSheets(active, { explode }), 'data.xlsx');
    onDownloaded();
  };

  const cycleDateOrder = (): DateOrderMode =>
    dateOrder === 'auto' ? 'DM' : dateOrder === 'DM' ? 'MD' : 'auto';
  const dateOrderLabel =
    dateOrder === 'auto' ? 'Dates: auto' : dateOrder === 'DM' ? 'Dates: DD-MM' : 'Dates: MM-DD';

  const downloadQuality = () => {
    downloadText(qualityToCSV(report), 'quality-report.csv', 'text/csv;charset=utf-8');
    onDownloaded();
  };

  const previewRows = active.rows.slice(0, 12);

  return (
    <div className="flex flex-col gap-5">
      {results.length > 1 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Processed files">
          {results.map((result, index) => (
            <button
              key={result.id}
              role="tab"
              aria-selected={index === activeIndex}
              className={`btn ${index === activeIndex ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                onSelectFile(index);
                setMode('preview');
              }}
              title={result.fileName}
            >
              {shortName(result.fileName)}
            </button>
          ))}
        </div>
      )}

      {/* ---------------------------------------------------- summary ---- */}
      <div className="card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Your data is ready</h2>
            <p className="muted text-sm mt-0.5">
              {shortName(report.fileName)} · <span className="font-semibold">{report.strategy}</span> ·{' '}
              {active.rows.length.toLocaleString()} rows × {active.columns.length} columns
            </p>
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <button
              className="btn btn-secondary"
              onClick={() => onDateOrderChange(cycleDateOrder())}
              title="R3 – 'auto' keeps date patterns the file never proves as written and files a suggestion in Needs review; DD-MM / MM-DD applies that order and re-runs the pipeline."
            >
              {dateOrderLabel}
            </button>
            <button
              className={`btn ${mode === 'review' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setMode(mode === 'review' ? 'preview' : 'review')}
              title="Low-confidence suggestions with Accept/Reject, plus rows flagged for review"
            >
              Needs review
              {active.review.length > 0 ? ` (${active.review.filter((item) => !item.applied).length})` : ''}
            </button>
            <button className="btn btn-secondary" onClick={downloadQuality}>
              Download quality report
            </button>
            <button className="btn btn-ghost" onClick={onRestart}>
              + Process more files
            </button>
          </div>
        </div>

        {/* preview */}
        <div className="grid-scroll rounded-lg border border-[var(--u2s-border)] mt-4 max-h-72">
          <table className="grid-table">
            <thead>
              <tr>
                {active.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{displayCell(cell) || <span className="text-slate-300 dark:text-slate-600">—</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted text-xs mt-2">
          Showing {previewRows.length} of {active.rows.length.toLocaleString()} cleaned rows — choose an output
          format below.
        </p>

        {/* choice cards */}
        <div className="grid gap-3 sm:grid-cols-2 mt-4">
          <button
            className={`card p-4 text-left transition hover:border-indigo-500 ${mode === 'tabular' ? 'border-indigo-600 ring-2 ring-indigo-600/30' : ''}`}
            onClick={() => setMode('tabular')}
          >
            <div className="flex items-center gap-2 font-semibold">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-white text-xs">A</span>
              Tabular
            </div>
            <p className="muted text-xs mt-1">
              Clean table with sorting, search and per-column filters. Download as CSV, XLSX or JSON.
            </p>
          </button>
          <button
            className={`card p-4 text-left transition hover:border-indigo-500 ${mode === 'pivot' ? 'border-indigo-600 ring-2 ring-indigo-600/30' : ''}`}
            onClick={() => setMode('pivot')}
          >
            <div className="flex items-center gap-2 font-semibold">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-white text-xs">B</span>
              Pivot table
            </div>
            <p className="muted text-xs mt-1">
              Drag-and-drop builder with sum, count, avg, min and max. Suggested default:{' '}
              <span className="font-semibold text-slate-700 dark:text-slate-300">
                {suggested.rows.join(', ') || '—'}
                {suggested.cols.length > 0 ? ` × ${suggested.cols.join(', ')}` : ''}
                {suggested.value ? ` → ${suggested.agg}(${suggested.value})` : ''}
              </span>
              . Download as XLSX or CSV.
            </p>
          </button>
        </div>
      </div>

      {/* --------------------------------------------------- tabular ------ */}
      {mode === 'tabular' && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" onClick={() => downloadTabular('csv')}>
                Download CSV
              </button>
              <button className="btn btn-secondary" onClick={() => downloadTabular('xlsx')}>
                Download XLSX
              </button>
              <button className="btn btn-secondary" onClick={() => downloadTabular('json')}>
                Download JSON
              </button>
              {hasItemCounts && (
                <label
                  className="btn btn-ghost inline-flex cursor-pointer items-center gap-2"
                  title="R17 – write one row per item on a second 'Exploded data' sheet. Off by default; the clean sheet never changes."
                >
                  <input
                    type="checkbox"
                    checked={explode}
                    onChange={(event) => setExplode(event.target.checked)}
                    className="h-4 w-4 accent-indigo-600"
                  />
                  Explode multi-item rows
                </label>
              )}
              <label
                className="btn btn-ghost inline-flex cursor-pointer items-center gap-2"
                title="A cell starting with = + - @ is a live formula in Excel. Prefixing it with an apostrophe keeps it as text. Trade-off: a text value like +44-1234 or -1 in a text column is exported as '+44-1234 / '-1, so it shows the quote in some viewers. Numbers and dates are never changed."
              >
                <input
                  type="checkbox"
                  checked={spreadsheetSafe}
                  onChange={(event) => setSpreadsheetSafe(event.target.checked)}
                  className="h-4 w-4 accent-indigo-600"
                />
                Spreadsheet-safe export
              </label>
            </div>
            <button className="btn btn-ghost" onClick={() => setMode('preview')}>
              ← Back to preview
            </button>
          </div>
          <TabularView dataset={active} />
        </div>
      )}

      {/* --------------------------------------------------- review ------ */}
      {mode === 'review' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="muted text-xs">
              Suggestions keep the original value until you accept them; flagged rows stay in the data either way.
            </span>
            <button className="btn btn-ghost" onClick={() => setMode('preview')}>
              ← Back to preview
            </button>
          </div>
          <NeedsReview dataset={active} onAccept={onAcceptReview} />
        </div>
      )}

      {/* ----------------------------------------------------- pivot ------ */}
      {mode === 'pivot' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="muted text-xs">Switch formats at any time — no re-upload needed.</span>
            <button className="btn btn-ghost" onClick={() => setMode('preview')}>
              ← Back to preview
            </button>
          </div>
          <PivotView
            dataset={active}
            onDownloaded={onDownloaded}
            spreadsheetSafe={spreadsheetSafe}
            onSpreadsheetSafeChange={setSpreadsheetSafe}
          />
        </div>
      )}

      <QualityPanel dataset={active} onDownloaded={onDownloaded} />
    </div>
  );
}
