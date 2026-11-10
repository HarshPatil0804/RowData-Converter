import type { Dataset } from '../types';
import { qualityToCSV, qualityToJSON, downloadText } from '../lib/export';
import { displayCell } from '../lib/strings';

export interface QualityPanelProps {
  dataset: Dataset;
  onDownloaded: () => void;
}

const TYPE_CLASS: Record<string, string> = {
  number: 'badge badge-number',
  date: 'badge badge-date',
  boolean: 'badge badge-boolean',
  text: 'badge badge-text',
};

export default function QualityPanel({ dataset, onDownloaded }: QualityPanelProps) {
  const report = dataset.report;

  // T1 – how much of each column actually parsed into its type. The weakest
  // column is the honest headline: "99% parsed" means nothing if one column is
  // half text, so it is a summary tile rather than a footnote.
  const parseByColumn = new Map(report.parseRates.map((rate) => [rate.column, rate]));
  const weakest = [...report.parseRates].sort((a, b) => a.rate - b.rate)[0];
  const conversionsByColumn = new Map<string, { kind: string; count: number }[]>();
  for (const conversion of report.conversions) {
    const list = conversionsByColumn.get(conversion.column) ?? [];
    list.push({ kind: conversion.kind, count: conversion.count });
    conversionsByColumn.set(conversion.column, list);
  }
  const conversionTotal = report.conversions.reduce((sum, entry) => sum + entry.count, 0);

  const summary: { label: string; value: string; hint?: string }[] = [
    { label: 'Rows in → clean', value: `${report.rowsIn.toLocaleString()} → ${report.rowsOut.toLocaleString()}` },
    {
      label: 'Rejected rows',
      value: report.rejectedCount.toLocaleString(),
      hint: 'title, export-date, error, alert, summary/total, footer/marker and system lines moved aside with a reason (R1/R11)',
    },
    { label: 'Duplicates removed', value: report.duplicatesRemoved.toLocaleString(), hint: 'exact duplicate rows after ID cleaning (R8)' },
    { label: 'Columns', value: `${report.columnsIn} → ${report.columnsOut}` },
    {
      label: 'Ambiguous dates',
      value: report.ambiguousDates.toLocaleString(),
      hint: 'day/month order unproven for their pattern — flip the date toggle to re-read them (R3)',
    },
    {
      label: 'Cells neutralised on export',
      value: report.spreadsheetSafeCells.toLocaleString(),
      hint: 'text cells starting with = + - @ that a spreadsheet would run as a formula — the CSV export prefixes them with an apostrophe unless you switch that off',
    },
    {
      label: 'Nulls fixed',
      value: report.nullsFixed.toLocaleString(),
      hint: 'sentinel values ("N/A", "-", "null"…) converted to real nulls',
    },
    {
      label: 'Values filled',
      value: report.valuesFilled.toLocaleString(),
      hint: 'text gaps filled with the column mode — only after you accept the suggestion (low confidence)',
    },
    {
      label: 'Outliers flagged',
      value: report.outliersFlagged.toLocaleString(),
      hint: 'IQR flags – never removed',
    },
    {
      label: 'Needs review',
      value: report.reviewItems.filter((item) => !item.applied).length.toLocaleString(),
      hint: 'low-confidence changes kept as original – accept or reject them in the Needs review tab (principle 2)',
    },
    {
      label: 'Weakest parse rate',
      value: weakest ? `${Math.round(weakest.rate * 100)}%` : '–',
      hint: weakest
        ? `${weakest.column}: ${weakest.parsed.toLocaleString()} of ${weakest.total.toLocaleString()} values parsed into the column type; the rest keep their original text in a _note column (T1)`
        : 'no typed column needed per-cell parsing',
    },
    {
      label: 'Values rewritten',
      value: conversionTotal.toLocaleString(),
      hint: 'cells rewritten by tolerant typing: currency and unit affixes, magnitudes, Excel serials, fractions, placeholders, phone and email normalisation (T2–T5, N1–N3)',
    },
    {
      label: 'Spelled numbers',
      value: report.spelledNumbers.toLocaleString(),
      hint: 'values written in words converted to digits (R13)',
    },
  ];

  return (
    <section className="card p-4 sm:p-5 flex flex-col gap-4" aria-label="Quality report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sm">Quality report</h3>
          <p className="muted text-xs">
            {report.strategy} · detected via {report.sourceType}
            {report.headerDetected ? ' · header detected' : ' · generated headers'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn btn-secondary"
            onClick={() => {
              downloadText(qualityToCSV(report), 'quality-report.csv', 'text/csv;charset=utf-8');
              onDownloaded();
            }}
          >
            Report CSV
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              downloadText(qualityToJSON(report), 'quality-report.json', 'application/json');
              onDownloaded();
            }}
          >
            Report JSON
          </button>
        </div>
      </div>

      {/* R10 – parsed vs reported total */}
      {report.reconciliation && (
        <div
          className={`rounded-xl border px-3 py-2 text-xs ${
            report.reconciliation.matches === false
              ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200'
              : 'border-[var(--u2s-border)] muted'
          }`}
          role="status"
        >
          <span className="font-semibold">Reconciliation ({report.reconciliation.column}):</span> parsed{' '}
          <span className="mono-num">{report.reconciliation.parsed.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          {report.reconciliation.reported !== null ? (
            <>
              {' '}vs reported{' '}
              <span className="mono-num">
                {report.reconciliation.reported.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>{' '}
              → difference{' '}
              <span className="mono-num">
                {(report.reconciliation.difference ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
              {' '}({report.reconciliation.matches ? 'matches' : 'does not match'})
            </>
          ) : (
            <span> — the file declares no total line.</span>
          )}
        </div>
      )}

      {/* R15 – "Total rows: N" control line vs the clean rows */}
      {report.rowControl && (
        <div
          className={`rounded-xl border px-3 py-2 text-xs ${
            report.rowControl.matches
              ? 'border-[var(--u2s-border)] muted'
              : 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200'
          }`}
          role="status"
        >
          <span className="font-semibold">Row control (R15):</span> the file declares{' '}
          <span className="mono-num">{report.rowControl.reported.toLocaleString()}</span> row(s), the clean table has{' '}
          <span className="mono-num">{report.rowControl.actual.toLocaleString()}</span> →{' '}
          <span className="font-semibold">{report.rowControl.matches ? 'matches' : 'does not match'}</span>
        </div>
      )}

      {/* Rules that actually did something for this file */}
      {report.rulesFired.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="muted font-semibold">Rules fired:</span>
          {report.rulesFired.map((rule) => (
            <span key={rule} className="badge badge-text" title={`rule ${rule} changed this file`}>
              {rule}
            </span>
          ))}
        </div>
      )}

      {/* R9/R7 – flag counts */}
      {report.flagCounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="muted font-semibold">Flags:</span>
          {report.flagCounts.map((flag) => (
            <span key={flag.name} className="badge badge-boolean" title={`rows flagged: ${flag.name}`}>
              {flag.name} · {flag.count.toLocaleString()}
            </span>
          ))}
        </div>
      )}

      {/* R1 – rejection reasons */}
      {report.rejectedReasons.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="muted font-semibold">Rejected:</span>
          {report.rejectedReasons.map((reason) => (
            <span key={reason.reason} className="badge badge-text" title={`rows rejected: ${reason.reason}`}>
              {reason.reason} · {reason.count.toLocaleString()}
            </span>
          ))}
        </div>
      )}

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {summary.map((item) => (
          <div key={item.label} className="rounded-xl border border-[var(--u2s-border)] p-3" title={item.hint}>
            <dt className="muted text-[0.68rem] uppercase tracking-wide font-semibold">{item.label}</dt>
            <dd className="text-lg font-bold mono-num mt-0.5">{item.value}</dd>
          </div>
        ))}
      </dl>

      <div className="grid-scroll rounded-lg border border-[var(--u2s-border)]">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Type</th>
              <th>Nulls</th>
              <th>Conversions</th>
              <th>Parsed</th>
              <th>Filled</th>
              <th>Unique</th>
              <th>Outliers</th>
              <th>Examples</th>
            </tr>
          </thead>
          <tbody>
            {report.columns.map((column) => (
              <tr key={column.name}>
                <td className="font-semibold">{column.name}</td>
                <td>
                  <span className={TYPE_CLASS[column.type] ?? 'badge badge-text'}>{column.type}</span>
                </td>
                <td className="mono-num">{column.nulls.toLocaleString()}</td>
                <td
                  className="mono-num"
                  title={
                    conversionsByColumn
                      .get(column.name)
                      ?.map((entry) => `${entry.count} × ${entry.kind}`)
                      .join('\n') || 'values converted into the column type (R3/R4/R6)'
                  }
                >
                  {column.conversions.toLocaleString()}
                </td>
                <td
                  className="mono-num"
                  title="share of this column's values that parsed into its type; the rest are kept as text in <column>_note (T1)"
                >
                  {parseByColumn.has(column.name)
                    ? `${Math.round((parseByColumn.get(column.name)?.rate ?? 0) * 100)}%`
                    : '–'}
                </td>
                <td className="mono-num">{column.filled}</td>
                <td className="mono-num">{column.unique.toLocaleString()}</td>
                <td className="mono-num">{column.outliers > 0 ? <span className="text-amber-600 dark:text-amber-400">{column.outliers}</span> : 0}</td>
                <td className="muted">{column.examples.map((example) => displayCell(example)).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer muted font-semibold">
          Pipeline notes ({report.notes.length})
        </summary>
        <ul className="mt-2 list-disc pl-5 space-y-1 muted">
          {report.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
          {report.files.length > 1 && (
            <li>
              archive contained {report.files.length} processed file(s)
            </li>
          )}
        </ul>
      </details>
    </section>
  );
}
