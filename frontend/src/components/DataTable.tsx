/* biome-ignore-all lint/suspicious/noExplicitAny: TanStack Table uses generics internally */
import {
	type ColumnDef,
	type SortingState,
	type ColumnFiltersState,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	useReactTable,
} from "@tanstack/react-table";
import { RefreshCw, Search, X, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { useState } from "react";

export interface DataTableProps<TData> {
	/** Column definitions — use `createColumnHelper<TData>()` from @tanstack/react-table */
	columns: ColumnDef<TData, any>[];
	data: TData[];
	loading?: boolean;
	error?: string | null;
	/** Placeholder text when table is empty */
	emptyText?: string;
	/** Placeholder text when search matches nothing */
	emptySearchText?: string;
	/** Placeholder for the global search input */
	searchPlaceholder?: string;
	/** Extra controls rendered after the search bar (e.g. a status filter select) */
	extraControls?: React.ReactNode;
	/** Default column to sort by */
	defaultSortId?: string;
	/** Default sort direction */
	defaultSortDesc?: boolean;
	/** Called when a row is clicked */
	onRowClick?: (row: TData) => void;
	/** Total count of unfiltered rows (to show x/total in header) */
	totalCount?: number;
}

function SortIndicator({ isSorted }: { isSorted: false | "asc" | "desc" }) {
	if (!isSorted) return <ChevronsUpDown size={12} className="sort-icon sort-icon-inactive" />;
	return isSorted === "asc"
		? <ChevronUp size={12} className="sort-icon sort-icon-active" />
		: <ChevronDown size={12} className="sort-icon sort-icon-active" />;
}

/**
 * Reusable headless table powered by TanStack Table v8.
 * Keeps all existing glass/dark styling — just adds sort + global filter built-in.
 */
export function DataTable<TData>({
	columns,
	data,
	loading,
	error,
	emptyText = "No records found.",
	emptySearchText = "No records match your search.",
	searchPlaceholder = "Search…",
	extraControls,
	defaultSortId,
	defaultSortDesc = true,
	onRowClick,
}: DataTableProps<TData>) {
	const [globalFilter, setGlobalFilter] = useState("");
	const [sorting, setSorting] = useState<SortingState>(
		defaultSortId ? [{ id: defaultSortId, desc: defaultSortDesc }] : []
	);
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

	const table = useReactTable({
		data,
		columns,
		state: { sorting, globalFilter, columnFilters },
		onSortingChange: setSorting,
		onGlobalFilterChange: setGlobalFilter,
		onColumnFiltersChange: setColumnFilters,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
	});

	const filteredCount = table.getRowModel().rows.length;
	const totalCount = data.length;
	const isFiltered = filteredCount !== totalCount || globalFilter || columnFilters.length > 0;

	return (
		<>
			{/* Search + extra controls bar */}
			<div className="table-controls glass-panel">
				<div className="table-search-wrap">
					<Search size={14} className="table-search-icon" />
					<input
						type="text"
						className="table-search"
						placeholder={searchPlaceholder}
						value={globalFilter}
						onChange={e => setGlobalFilter(e.target.value)}
					/>
					{globalFilter && (
						<button
							type="button"
							className="table-search-clear"
							onClick={() => setGlobalFilter("")}
							title="Clear search"
						>
							<X size={12} />
						</button>
					)}
				</div>
				{extraControls}
				{isFiltered && (
					<span className="table-count-badge">
						{filteredCount}<span className="text-muted"> / {totalCount}</span>
					</span>
				)}
			</div>

			{error && <div className="table-error glass-panel">{error}</div>}

			<div className="glass-panel table-panel">
				<div className="table-wrapper">
					<table className="table">
						<thead>
							{table.getHeaderGroups().map(headerGroup => (
								<tr key={headerGroup.id}>
									{headerGroup.headers.map(header => {
										const canSort = header.column.getCanSort();
										return (
											<th
												key={header.id}
												className={canSort ? "th-sortable" : undefined}
												onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
												style={(header.column.columnDef.meta as any)?.headerStyle}
											>
												{header.isPlaceholder ? null : (
													<span className="th-inner">
														{flexRender(header.column.columnDef.header, header.getContext())}
														{canSort && (
															<SortIndicator isSorted={header.column.getIsSorted()} />
														)}
													</span>
												)}
											</th>
										);
									})}
								</tr>
							))}
						</thead>
						<tbody>
							{loading && (
								<tr>
									<td colSpan={columns.length} className="table-placeholder">
										<RefreshCw size={18} className="spin" /> Loading…
									</td>
								</tr>
							)}
							{!loading && table.getRowModel().rows.length === 0 && (
								<tr>
									<td colSpan={columns.length} className="table-placeholder">
										{globalFilter || columnFilters.length > 0 ? emptySearchText : emptyText}
									</td>
								</tr>
							)}
							{!loading && table.getRowModel().rows.map(row => (
								<tr
									key={row.id}
									onClick={onRowClick ? () => onRowClick(row.original) : undefined}
									style={onRowClick ? { cursor: "pointer" } : undefined}
								>
									{row.getVisibleCells().map(cell => (
										<td
											key={cell.id}
											style={(cell.column.columnDef.meta as any)?.cellStyle}
										>
											{flexRender(cell.column.columnDef.cell, cell.getContext())}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</>
	);
}
