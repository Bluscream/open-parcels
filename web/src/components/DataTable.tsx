import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronsUpDown, ChevronUp, Search } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

export interface DataTableProps<TData> {
  /** Column definitions; build them with `createColumnHelper<TData>()`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack's column helper yields ColumnDef<T, any>; the value type differs per column.
  readonly columns: ColumnDef<TData, any>[];
  readonly data: TData[];
  readonly caption: string;
  readonly emptyText?: string;
  readonly searchLabel?: string;
  /** Controls placed beside the search box, such as filters. */
  readonly extraControls?: ReactNode;
  readonly defaultSort?: SortingState;
  readonly rowClassName?: (row: TData) => string | undefined;
}

function SortIcon({ sorted }: { readonly sorted: false | "asc" | "desc" }): ReactNode {
  if (sorted === false) {
    return <ChevronsUpDown size={12} className="sort-icon" aria-hidden="true" />;
  }
  const Icon = sorted === "asc" ? ChevronUp : ChevronDown;
  return <Icon size={12} className="sort-icon active" aria-hidden="true" />;
}

/** A sortable, searchable table built on TanStack Table. Headers are buttons, so sorting works by keyboard. */
export function DataTable<TData>(props: DataTableProps<TData>): ReactNode {
  const [sorting, setSorting] = useState<SortingState>(props.defaultSort ?? []);
  const [filter, setFilter] = useState("");
  const searchId = useId();
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table returns fresh functions on purpose.
  const table = useReactTable({
    data: props.data,
    columns: props.columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  const rows = table.getRowModel().rows;

  return (
    <div className="data-table">
      <div className="table-toolbar glass-panel">
        <label htmlFor={searchId} className="visually-hidden">
          {props.searchLabel ?? "Search"}
        </label>
        <div className="search-wrap">
          <Search size={14} aria-hidden="true" />
          <input
            id={searchId}
            type="search"
            placeholder={`${props.searchLabel ?? "Search"}…`}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
            }}
          />
        </div>
        {props.extraControls}
        <span className="count" aria-live="polite">
          {rows.length} of {props.data.length}
        </span>
      </div>
      <div className="table-scroll glass-panel">
        <table>
          <caption className="visually-hidden">{props.caption}</caption>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const ariaSort =
                    sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none";
                  return (
                    <th key={header.id} scope="col" aria-sort={ariaSort}>
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          className="sort-button"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <SortIcon sorted={sorted} />
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={props.columns.length} className="muted empty">
                  {filter === "" ? (props.emptyText ?? "Nothing here yet.") : "Nothing matches."}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className={props.rowClassName?.(row.original)}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
