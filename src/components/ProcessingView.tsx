export interface ProcessingViewProps {
  pct: number;
  message: string;
  current: number;
  total: number;
  /** Stops the worker and returns to the upload screen. */
  onCancel: () => void;
}

const STAGES = ['detect', 'extract', 'structure', 'clean', 'report'] as const;

export default function ProcessingView({ pct, message, current, total, onCancel }: ProcessingViewProps) {
  const clamped = Math.max(0, Math.min(100, pct));

  return (
    <div className="card p-6 sm:p-8 flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Processing{total > 1 ? ` file ${current} of ${total}` : ''}</h2>
          <p className="muted text-sm mt-0.5">{message}</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold mono-num text-indigo-600 dark:text-indigo-400">
            {Math.round(clamped)}%
          </div>
        </div>
      </div>

      <div className="h-3 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden" role="progressbar"
        aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100}>
        <div
          className="h-full rounded-full bg-indigo-600 transition-[width] duration-200 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>

      <ol className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        {STAGES.map((stage, index) => {
          const stagePct = ((index + 1) / STAGES.length) * 100;
          const done = clamped >= stagePct;
          const active = !done && clamped >= (index / STAGES.length) * 100;
          return (
            <li
              key={stage}
              className={[
                'rounded-lg px-2 py-1.5 font-semibold uppercase tracking-wide text-center border',
                done
                  ? 'bg-indigo-50 border-indigo-200 text-indigo-700 dark:bg-indigo-950 dark:border-indigo-900 dark:text-indigo-300'
                  : active
                    ? 'bg-amber-50 border-amber-300 text-amber-700 dark:bg-amber-950 dark:border-amber-800 dark:text-amber-300 animate-pulse'
                    : 'border-slate-200 text-slate-400 dark:border-slate-800',
              ].join(' ')}
            >
              {stage}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="muted text-xs">
          All parsing, OCR and cleaning runs in a Web Worker on this device — nothing is uploaded anywhere.
        </p>
        <button className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
