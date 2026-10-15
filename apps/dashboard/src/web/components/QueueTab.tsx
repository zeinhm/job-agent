import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Queue } from "../api.ts";
import { DetailPanel } from "./DetailPanel.tsx";
import { SectionTable, type QueueRow } from "./SectionTable.tsx";

const SECTIONS = [
  { key: "top", title: "Top matches" },
  { key: "needs_a_look", title: "Needs a look" },
  { key: "suspicious", title: "Suspicious" },
  { key: "waiting", title: "Waiting for scoring" },
] as const;

/** The day's matches: Top and Suspicious (Needs a look repeats entries, Waiting is not scored yet). */
export function progress(queue: Queue): { processed: number; matches: number } {
  const seen = new Map<string, boolean>();
  for (const item of [...queue.sections.top, ...queue.sections.suspicious])
    seen.set(item.postingId, item.review.processed);
  return { processed: [...seen.values()].filter(Boolean).length, matches: seen.size };
}

export function QueueTab({ day }: { day: string }) {
  const [openOnly, setOpenOnly] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["queue", day], queryFn: () => api.queue(day) });

  if (q.isPending) return <p>Loading...</p>;
  if (q.isError) return <p role="alert">Could not load the queue.</p>;
  const queue = q.data;
  const total = SECTIONS.reduce((n, s) => n + queue.sections[s.key].length, 0);
  const { processed, matches } = progress(queue);

  return (
    <div className="queue">
      <p className="progress" role="status" aria-label="Progress">
        {processed} of {matches} processed
      </p>
      <label>
        <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />{" "}
        Open only
      </label>
      {total === 0 && <p className="empty">No postings in the queue for this day. ({day})</p>}
      <div className="queue-layout">
        <div className="sections">
          {SECTIONS.map((s) => {
            const all = queue.sections[s.key];
            if (all.length === 0) return null;
            const rows: QueueRow[] = all
              .map((item, i) => ({ ...item, rank: i + 1 }))
              .filter((r) => !openOnly || !r.review.processed);
            return (
              <section key={s.key} aria-label={s.title}>
                <h3>
                  {s.title} ({rows.length})
                </h3>
                {rows.length === 0 ? (
                  <p className="empty">Nothing open in this section.</p>
                ) : (
                  <SectionTable
                    label={s.title}
                    rows={rows}
                    selectedId={selected}
                    onSelect={setSelected}
                  />
                )}
              </section>
            );
          })}
        </div>
        {selected !== null && (
          <DetailPanel postingId={selected} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  );
}
