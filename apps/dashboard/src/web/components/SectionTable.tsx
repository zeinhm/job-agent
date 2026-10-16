import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { endSentence } from "@job-agent/core/sentence";
import { useMemo, useRef } from "react";
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

/** Full tier and ask as the detail panel states it; the table cell carries it as its hover title. */
function tierAsk(r: QueueRow): string {
  return [r.tier, r.ask ?? (r.askText === null ? null : endSentence(r.askText))]
    .filter((x) => x !== null && x !== "")
    .join(" / ");
}

/** Table form of the ask: the first money figure without its period, or "text" when only a text answer exists. */
function shortAsk(r: QueueRow): string | null {
  const money = r.ask
    ?.split(" | ")
    .find((part) => /^(IDR|USD) /.test(part))
    ?.replace(/ \/ (month|year)$/, "");
  if (money !== undefined) return money;
  return r.ask !== null || r.askText !== null ? "text" : null;
}

function tierAskShort(r: QueueRow): string {
  return [r.tier, shortAsk(r)].filter((x) => x !== null && x !== "").join(" / ");
}

/** Full value of a cell for its hover title; the table cuts long cells with an ellipsis. */
function cellTitle(r: QueueRow, cell: { column: { id: string }; getValue: () => unknown }) {
  if (cell.column.id === "tierAsk") return tierAsk(r);
  const value = cell.getValue();
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

export function SectionTable({
  label,
  rows,
  selectedId,
  onSelect,
  checked,
  onCheck,
}: {
  label: string;
  rows: QueueRow[];
  selectedId: string | null;
  onSelect: (postingId: string) => void;
  /** Postings ticked for a bulk action. */
  checked: ReadonlySet<string>;
  onCheck: (postingIds: string[], value: boolean) => void;
}) {
  const anchor = useRef<string | null>(null);
  // Shift-click ticks (or unticks) every row between the last clicked checkbox and this one, in the shown order.
  const click = (ids: string[], id: string, shift: boolean, value: boolean) => {
    const from = anchor.current === null ? -1 : ids.indexOf(anchor.current);
    const to = ids.indexOf(id);
    anchor.current = id;
    if (!shift || from < 0) return onCheck([id], value);
    onCheck(ids.slice(Math.min(from, to), Math.max(from, to) + 1), value);
  };
  const shownIds = useRef<string[]>([]);
  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("rank", {
          header: "Rank",
          sortUndefined: "last",
          cell: (ctx) => {
            const id = ctx.row.original.postingId;
            const on = checked.has(id);
            return (
              <>
                <input
                  type="checkbox"
                  aria-label={`Select ${ctx.row.original.title}`}
                  checked={on}
                  onChange={() => undefined}
                  onClick={(e) => click(shownIds.current, id, e.shiftKey, !on)}
                />{" "}
                {ctx.getValue()}
              </>
            );
          },
        }),
        helper.accessor("title", {
          header: "Title",
          enableSorting: false,
          cell: (ctx) => (
            <button
              type="button"
              className="link clamp"
              onClick={() => onSelect(ctx.row.original.postingId)}
            >
              {ctx.getValue()}
            </button>
          ),
        }),
        helper.accessor("company", {
          header: "Company",
          enableSorting: false,
          cell: (ctx) => <span className="clamp">{ctx.getValue()}</span>,
        }),
        helper.accessor((r) => r.fitScore ?? undefined, {
          id: "fit",
          header: "Fit",
          sortUndefined: "last",
          cell: (ctx) => ctx.getValue() ?? "-",
        }),
        helper.accessor((r) => tierAskShort(r), {
          id: "tierAsk",
          header: "Tier / ask",
          enableSorting: false,
        }),
        helper.accessor("listedSalary", { header: "Salary", enableSorting: false }),
        helper.accessor("applyType", { header: "Apply", enableSorting: false }),
        helper.accessor(
          (r) => (r.questions.total === 0 ? "-" : `${r.questions.covered}/${r.questions.total}`),
          {
            id: "questions",
            header: "Questions",
            enableSorting: false,
          },
        ),
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
    [onSelect, checked, onCheck],
  );
  const table = useTable({
    features,
    columns,
    data: rows,
    initialState: { sorting: [{ id: "rank", desc: false }] },
  });

  shownIds.current = table.getRowModel().rows.map((r) => r.original.postingId);

  return (
    <div className="table-scroll">
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
                    className={`col-${header.column.id}`}
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
                <td
                  key={cell.id}
                  className={`col-${cell.column.id}`}
                  title={cell.column.id === "rank" ? undefined : cellTitle(row.original, cell)}
                >
                  <table.FlexRender cell={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
