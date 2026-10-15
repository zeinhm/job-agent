import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useMemo } from "react";
import type { QueueItem } from "../api.ts";

export interface QueueRow extends QueueItem {
  /** 1-based position the server listed the posting at in its section. */
  rank: number;
}

const features = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel() });
const helper = createColumnHelper<typeof features, QueueRow>();

export function reviewLabel(r: QueueItem["review"]): string {
  return r.status === "not_interested" && r.reason !== null
    ? `not interested (${r.reason})`
    : r.status.replaceAll("_", " ");
}

function tierAsk(r: QueueRow): string {
  return [r.tier, r.ask ?? r.askText].filter((x) => x !== null && x !== "").join(" / ");
}

export function SectionTable({
  label,
  rows,
  selectedId,
  onSelect,
}: {
  label: string;
  rows: QueueRow[];
  selectedId: string | null;
  onSelect: (postingId: string) => void;
}) {
  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("rank", { header: "Rank", sortUndefined: "last" }),
        helper.accessor("title", {
          header: "Title",
          enableSorting: false,
          cell: (ctx) => (
            <button
              type="button"
              className="link"
              onClick={() => onSelect(ctx.row.original.postingId)}
            >
              {ctx.getValue()}
            </button>
          ),
        }),
        helper.accessor("company", { header: "Company", enableSorting: false }),
        helper.accessor((r) => r.fitScore ?? undefined, {
          id: "fit",
          header: "Fit",
          sortUndefined: "last",
          cell: (ctx) => ctx.getValue() ?? "-",
        }),
        helper.accessor((r) => tierAsk(r), {
          id: "tierAsk",
          header: "Tier / ask",
          enableSorting: false,
        }),
        helper.accessor("listedSalary", { header: "Salary", enableSorting: false }),
        helper.accessor("applyType", { header: "Apply", enableSorting: false }),
        helper.accessor((r) => r.flags.join(", "), {
          id: "flags",
          header: "Flags",
          enableSorting: false,
        }),
        helper.accessor((r) => reviewLabel(r.review), {
          id: "review",
          header: "Review",
          enableSorting: false,
        }),
      ]),
    [onSelect],
  );
  const table = useTable({
    features,
    columns,
    data: rows,
    initialState: { sorting: [{ id: "rank", desc: false }] },
  });

  return (
    <table aria-label={label}>
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((header) => {
              const sorted = header.column.getIsSorted();
              const sortable = header.column.getCanSort();
              return (
                <th
                  key={header.id}
                  aria-sort={
                    sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                  }
                >
                  {sortable ? (
                    <button
                      type="button"
                      className="link"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <table.FlexRender header={header} />
                      {sorted === "asc" ? " ▲" : sorted === "desc" ? " ▼" : ""}
                    </button>
                  ) : (
                    <table.FlexRender header={header} />
                  )}
                </th>
              );
            })}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr
            key={row.id}
            aria-selected={row.original.postingId === selectedId}
            className={row.original.postingId === selectedId ? "selected" : undefined}
          >
            {row.getAllCells().map((cell) => (
              <td key={cell.id}>
                <table.FlexRender cell={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
