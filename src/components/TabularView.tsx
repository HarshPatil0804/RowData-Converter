import { useEffect, useMemo, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
} from '@tanstack/react-table';
import type { Cell, ColumnType, Dataset } from '../types';
import { displayCell } from '../lib/strings';

export interface TabularViewProps {
  dataset: Dataset;
}

const TYPE_CLASS: Record<ColumnType, string> = {
  number: 'badge badge-number',
  date: 'badge badge-date',
  boolean: 'badge badge-boolean',
  text: 'badge badge-text',
};

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

function formatCell(value: Cell, type: ColumnType): string {
  if (value === null || value === undefined) return '';
  if (type === 'number' && typeof value === 'number') return numberFormat.format(value);
  if (type === 'boolean' && typeof value === 'boolean') return value ? 'true' : 'false';
  return displayCell(value);
}

export default function TabularView({ dataset }: TabularViewProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [search, setSearch] = useState('');

  // Debounce the search box so huge files stay responsive while typing.
  useEffect(() => {
    const timer = window.setTimeout(() => setGlobalFilter(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const columns = useMemo<ColumnDef<Cell[]>[]>(() => {
    const all: ColumnDef<Cell[]>[] = dataset.columns.map((name, index) => ({
      id: name,
      accessorFn: (row) => row[index],
      header: name,
      cell: (info) => formatCell(info.getValue() as Cell, dataset.types[index]),
      sortingFn: (a, b, columnId) => {
        const left = a.getValue(columnId) as Cell;
        const right = b.getValue(columnId) as Cell;
        if (left === right) return 0;
        if (left === null || left === undefined) return 1;
        if (right === null || right === undefined) return -1;
        if (typeof left === 'number' && typeof right === 'number') return left - right;
        return String(left).localeCompare(String(right), undefined, { numeric: true });
      },
    }));
    return all;
  }, [dataset]);

  const table = useReactTable({
    data: dataset.rows,
    columns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageIndex: 0, pageSize: 50 } },
  });

  const filteredCount = table.getFilteredRowModel().rows.length;
  const pageRows = table.getRowModel().rows;
  const pageCount = Math.max(1, table.getPageCount());

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-3 border-b border-[var(--u2s-border)]">
        <input
          className="input flex-1 min-w-[12rem]"
          placeholder="Search all columns…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search rows"
        />
        <label className="muted text-xs flex items-center gap-2">
          Rows per page
          <select
            className="input"
            defaultValue={50}
            onChange={(event) => table.setPageSize(Number(event.target.value))}
            aria-label="Rows per page"
          >
            {[25, 50, 100, 250].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <span className="muted text-xs mono-num">
          {filteredCount.toLocaleString()} of {dataset.rows.length.toLocaleString()} rows
          {globalFilter || columnFilters.length > 0 ? ' (filtered)' : ''}
        </span>
      </div>

      <div className="grid-scroll">
        <table className="grid-table">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const type = dataset.types[header.column.getIndex()];
                  return (
                    <th key={header.id} className="cursor-pointer select-none" title="Click to sort">
                      <div className="flex items-center gap-1.5" onClick={header.column.getToggleSortingHandler()}>
                        <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                        <span className={`${TYPE_CLASS[type]} !px-1 !py-0 !text-[0.55rem]`}>{type}</span>
                        <span className="text-indigo-500 text-[0.65rem]">
                          {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '↕'}
                        </span>
                      </div>
                    </th>
                  );
                })}
              </tr>
            ))}
            <tr>
              {table.getHeaderGroups()[0].headers.map((header) => (
                <th key={header.id}>
                  <input
                    className="input w-full !py-1 !text-xs"
                    placeholder="Filter…"
                    aria-label={`Filter ${String(header.column.columnDef.header)}`}
                    value={(header.column.getFilterValue() as string) ?? ''}
                    onChange={(event) => header.column.setFilterValue(event.target.value || undefined)}
                    onClick={(event) => event.stopPropagation()}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} title={displayCell(cell.getValue() as Cell) || undefined}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext()) || (
                      <span className="text-slate-300 dark:text-slate-600">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="muted text-center py-8">
                  No rows match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 p-3 border-t border-[var(--u2s-border)]">
        <span className="muted text-xs mono-num">
          Page {(table.getState().pagination.pageIndex + 1).toLocaleString()} of {pageCount.toLocaleString()}
        </span>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-secondary" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            ← Previous
          </button>
          <button className="btn btn-secondary" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
