import { useMemo, useState } from 'react';
import type { Dataset } from '../types';
import { displayCell } from '../lib/strings';

export interface NeedsReviewProps {
  dataset: Dataset;
  /** Principle 2 – accepting a suggestion re-runs the pipeline with it applied. */
  onAccept?: (id: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  date_order: 'date order (R3)',
  value_fill: 'fill gaps (R9)',
  missing_id: 'missing id (R14)',
  overlap: 'overlapping value (R18)',
  serial_dates: 'converted from serial (T3)',
  parse_gap: 'cells left as text (T1)',
  similar_values: 'similar values (S1)',
  table_split: 'table split (S2)',
};

/**
 * The "Needs review" tab:
 *  1. low-confidence suggestions with a suggested fix and Accept/Reject –
 *     the original value stays until you Accept (which re-runs the pipeline);
 *  2. every row carrying a flag (R3/R7/R8/R9). Nothing is ever removed from
 *     the data – this is a review queue, not a filter.
 */
export default function NeedsReview({ dataset, onAccept }: NeedsReviewProps) {
  const flagColumns = dataset.flagColumns;
  const [activeFlag, setActiveFlag] = useState<string>('all');
  const [rejected, setRejected] = useState<Set<string>>(() => new Set());

  const items = dataset.review;

  const flagIndex = useMemo(
    () => new Map(flagColumns.map((name) => [name, dataset.columns.indexOf(name)])),
    [dataset.columns, flagColumns],
  );

  const isFlagged = (row: (string | number | boolean | null)[], name: string): boolean => {
    const index = flagIndex.get(name);
    if (index === undefined || index < 0) return false;
    return row[index] === true || row[index] === 'true' || row[index] === 1;
  };

  const flaggedRows = useMemo(() => {
    const out: { rowIndex: number; row: (string | number | boolean | null)[]; flags: string[] }[] = [];
    dataset.rows.forEach((row, rowIndex) => {
      const flags = flagColumns.filter((name) => isFlagged(row, name));
      if (flags.length > 0) out.push({ rowIndex, row, flags });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.rows, flagColumns, flagIndex]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    flagColumns.forEach((name) => map.set(name, 0));
    flaggedRows.forEach((entry) => entry.flags.forEach((name) => map.set(name, (map.get(name) ?? 0) + 1)));
    return map;
  }, [flagColumns, flaggedRows]);

  const shown = activeFlag === 'all' ? flaggedRows : flaggedRows.filter((entry) => entry.flags.includes(activeFlag));

  // Context columns: the first two non-flag columns give each row an identity.
  const context = dataset.columns
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => !flagColumns.includes(name) && !name.endsWith('_raw'))
    .slice(0, 3);

  if (flagColumns.length === 0 && items.length === 0) {
    return (
      <div className="card p-5">
        <h3 className="font-semibold text-sm">Needs review</h3>
        <p className="muted text-xs mt-1">
          Nothing to review in this file — no low-confidence changes, ambiguous dates, id conflicts or logic issues
          were detected.
        </p>
      </div>
    );
  }

  const pending = items.filter((item) => !item.applied && !rejected.has(item.id));

  const suggestions = items.length === 0 ? null : (
    <div className="card p-4 flex flex-col gap-3">
      <div>
        <h3 className="font-semibold text-sm">Suggestions</h3>
        <p className="muted text-xs mt-0.5">
          Low-confidence changes are <span className="font-semibold">not applied</span> — the original value stays
          until you Accept. Accepting re-runs the pipeline with the suggestion applied.
          {pending.length > 0 ? ` ${pending.length} waiting for you.` : ''}
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((item) => {
          const isRejected = rejected.has(item.id);
          const dimmed = item.applied || isRejected;
          return (
            <li
              key={item.id}
              className={`rounded-xl border border-[var(--u2s-border)] p-3 ${dimmed ? 'opacity-70' : ''}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="badge badge-text">{KIND_LABEL[item.kind] ?? item.kind}</span>
                    <span className="font-semibold">{item.column}</span>
                    <span className="muted" title="confidence of the automatic decision">
                      confidence {Math.round(item.confidence * 100)}%
                    </span>
                    {item.applied && (
                      <span className="badge badge-boolean" title="the suggestion was applied to the data">
                        applied
                      </span>
                    )}
                    {isRejected && <span className="badge badge-number">rejected — original kept</span>}
                  </div>
                  <p className="muted text-xs mt-1">{item.reason}</p>
                  {!item.applied && (
                    <p className="text-xs mt-1 mono-num">
                      {item.original ? (
                        <>
                          <span className="line-through opacity-70">{item.original}</span>{' '}
                          <span className="muted">→</span>{' '}
                        </>
                      ) : null}
                      <span className="font-semibold">{item.suggested}</span>
                    </p>
                  )}
                </div>
                {!item.applied && (
                  <div className="flex shrink-0 gap-2">
                    {!isRejected ? (
                      <>
                        <button
                          className="btn btn-primary text-xs"
                          onClick={() => onAccept?.(item.id)}
                          disabled={!onAccept}
                          title="Re-run the pipeline with this suggestion applied"
                        >
                          Accept
                        </button>
                        <button
                          className="btn btn-secondary text-xs"
                          onClick={() =>
                            setRejected((previous) => {
                              const next = new Set(previous);
                              next.add(item.id);
                              return next;
                            })
                          }
                          title="Keep the original value and hide the suggestion"
                        >
                          Reject
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn btn-ghost text-xs"
                        onClick={() =>
                          setRejected((previous) => {
                            const next = new Set(previous);
                            next.delete(item.id);
                            return next;
                          })
                        }
                      >
                        Undo
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {suggestions}

      {flagColumns.length === 0 ? (
        <div className="card p-5">
          <h3 className="font-semibold text-sm">Flagged rows</h3>
          <p className="muted text-xs mt-1">No rows carry a flag in this file.</p>
        </div>
      ) : (
      <>
      <div className="card p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-sm">Needs review</h3>
            <p className="muted text-xs mt-0.5">
              {flaggedRows.length.toLocaleString()} of {dataset.rows.length.toLocaleString()} rows carry at least one
              flag. Flagged rows stay in the data — nothing was deleted.
            </p>
          </div>
          <button
            className="btn btn-ghost"
            onClick={() => setActiveFlag('all')}
            aria-pressed={activeFlag === 'all'}
          >
            Show all
          </button>
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by flag">
          <button
            className={`btn text-xs ${activeFlag === 'all' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveFlag('all')}
          >
            all ({flaggedRows.length.toLocaleString()})
          </button>
          {flagColumns.map((name) => (
            <button
              key={name}
              className={`btn text-xs ${activeFlag === name ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveFlag(name)}
              title={`Show only rows flagged: ${name}`}
            >
              {name} ({(counts.get(name) ?? 0).toLocaleString()})
            </button>
          ))}
        </div>
      </div>

      <div className="grid-scroll rounded-lg border border-[var(--u2s-border)] max-h-[28rem]">
        <table className="grid-table">
          <thead>
            <tr>
              <th>#</th>
              {context.map((column) => (
                <th key={column.name}>{column.name}</th>
              ))}
              <th>flags</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.rowIndex}>
                <td className="mono-num muted">{entry.rowIndex + 1}</td>
                {context.map((column) => (
                  <td key={column.name}>{displayCell(entry.row[column.index])}</td>
                ))}
                <td>
                  <span className="flex flex-wrap gap-1">
                    {entry.flags.map((name) => (
                      <span key={name} className="badge badge-boolean" title={`flagged: ${name}`}>
                        {name}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={context.length + 2} className="muted text-center py-4">
                  No rows carry this flag.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted text-xs">
        Showing {shown.length.toLocaleString()} row(s){activeFlag !== 'all' ? ` flagged ${activeFlag}` : ''}.
      </p>
      </>
      )}
    </div>
  );
}
