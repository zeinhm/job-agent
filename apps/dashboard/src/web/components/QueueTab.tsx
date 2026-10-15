import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  NOT_INTERESTED_REASONS,
  type NotInterestedReason,
  type Queue,
  type QueueItem,
  type STATUS_ACTIONS,
} from "../api.ts";
import { jakartaDate } from "../day.ts";
import { isTyping, REASON_KEYS, SHORTCUTS } from "../shortcuts.ts";
import { DetailPanel } from "./DetailPanel.tsx";
import { safeHref } from "./ExternalLink.tsx";
import { SectionTable, type QueueRow } from "./SectionTable.tsx";

const SECTIONS = [
  { key: "top", title: "Top matches" },
  { key: "needs_a_look", title: "Needs a look" },
  { key: "suspicious", title: "Suspicious" },
  { key: "waiting", title: "Waiting for scoring" },
] as const;

const UNDO_WINDOW_MS = 10_000;
const label = (s: string) => s.replaceAll("_", " ");

type StatusAction = (typeof STATUS_ACTIONS)[number];
const KEY_ACTIONS: Readonly<Record<string, StatusAction>> = {
  i: "interested",
  a: "applied_manually",
  l: "later",
};

/** The day's matches: Top and Suspicious (Needs a look repeats entries, Waiting is not scored yet). */
export function progress(queue: Queue): { processed: number; matches: number } {
  const seen = new Map<string, boolean>();
  for (const item of [...queue.sections.top, ...queue.sections.suspicious])
    seen.set(item.postingId, item.review.processed);
  return { processed: [...seen.values()].filter(Boolean).length, matches: seen.size };
}

/** Elapsed time since the day's first review action, as the API reports it (never since page load). */
function ElapsedTimer({ since, now }: { since: string | null; now: () => Date }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (since === null)
    return (
      <p role="timer" aria-label="Elapsed">
        Elapsed: starts with the first review
      </p>
    );
  const s = Math.max(0, Math.floor((now().getTime() - Date.parse(since)) / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  const text =
    s >= 3600
      ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`
      : `${Math.floor(s / 60)}:${two(s % 60)}`;
  return (
    <p role="timer" aria-label="Elapsed">
      Elapsed: {text}
    </p>
  );
}

interface LastAction {
  ids: string[];
  what: string;
}

function QueueView({ day, queue, now }: { day: string; queue: Queue; now: () => Date }) {
  const client = useQueryClient();
  const [openOnly, setOpenOnly] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [awaitingReason, setAwaitingReason] = useState(false);
  const [help, setHelp] = useState(false);
  const [last, setLast] = useState<LastAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkReason, setBulkReason] = useState<NotInterestedReason | "">("");
  const [bulkNote, setBulkNote] = useState("");
  const busy = useRef(false);

  const rowsOf = (key: (typeof SECTIONS)[number]["key"]): QueueRow[] =>
    queue.sections[key]
      .map((item, i) => ({ ...item, rank: i + 1 }))
      .filter((r) => !openOnly || !r.review.processed);
  const byId = new Map<string, QueueItem>();
  for (const s of SECTIONS)
    for (const item of queue.sections[s.key]) byId.set(item.postingId, item);
  // Keyboard order: the shown rows, section by section (the server's rank order), each posting once.
  const order = [...new Set(SECTIONS.flatMap((s) => rowsOf(s.key).map((r) => r.postingId)))];
  const total = SECTIONS.reduce((n, s) => n + queue.sections[s.key].length, 0);
  const { processed, matches } = progress(queue);
  const live = day === jakartaDate(now()); // the timer only runs for today

  // The undo offer lasts 10 s.
  useEffect(() => {
    if (last === null) return;
    const id = setTimeout(() => setLast(null), UNDO_WINDOW_MS);
    return () => clearTimeout(id);
  }, [last]);

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["queue"] }),
      client.invalidateQueries({ queryKey: ["posting"] }),
    ]);

  /** Runs one request at a time; keys pressed meanwhile are dropped. */
  const guarded = useCallback(async (run: () => Promise<void>, failure: string) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      await run();
    } catch {
      setError(failure);
    } finally {
      busy.current = false;
    }
  }, []);

  /** The first open row after `from` (wrapping), skipping the postings that were just handled. */
  const nextOpen = (from: string | null, skip: ReadonlySet<string>): string | null => {
    const start = from === null ? -1 : order.indexOf(from);
    for (let n = 1; n <= order.length; n++) {
      const id = order[(start + n + order.length) % order.length];
      if (id === undefined || skip.has(id)) continue;
      if (byId.get(id)?.review.processed !== true) return id;
    }
    return null;
  };

  const targets = (): string[] =>
    checked.size > 0 ? [...checked] : selected === null ? [] : [selected];

  const act = (action: StatusAction, reason?: NotInterestedReason, note?: string) => {
    const ids = targets();
    if (ids.length === 0) return Promise.resolve();
    return guarded(async () => {
      if (checked.size > 0) {
        await api.bulk({
          posting_ids: ids,
          action,
          ...(reason === undefined ? {} : { reason }),
          ...(note === undefined || note === "" ? {} : { note }),
        });
      } else {
        await api.review({
          posting_id: ids[0] ?? "",
          action,
          ...(reason === undefined ? {} : { reason }),
        });
      }
      const handled = new Set(ids);
      setLast({ ids, what: `${label(action)} (${ids.length})` });
      setChecked(new Set());
      setBulkReason("");
      setBulkNote("");
      setSelected(nextOpen(selected, handled));
      await refresh();
    }, "Saving failed. Nothing was recorded.");
  };

  const undo = () => {
    if (last === null) return Promise.resolve();
    const ids = last.ids;
    return guarded(async () => {
      await api.undo(ids);
      setLast(null);
      setSelected(ids[0] ?? null);
      await refresh();
    }, "Undo failed. Nothing was changed.");
  };

  const sendScam = () => {
    if (selected === null) return Promise.resolve();
    const posting_id = selected;
    return guarded(async () => {
      await api.review({ posting_id, action: "scam" });
      await refresh();
    }, "Saving failed. Nothing was recorded.");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (awaitingReason) {
        e.preventDefault();
        setAwaitingReason(false);
        const reason = REASON_KEYS[e.key];
        if (reason !== undefined) void act("not_interested", reason);
        return;
      }
      switch (e.key) {
        case "j":
        case "k": {
          const i = selected === null ? -1 : order.indexOf(selected);
          const next =
            e.key === "j"
              ? order[Math.min(i + 1, order.length - 1)]
              : order[i < 0 ? order.length - 1 : Math.max(i - 1, 0)];
          if (next !== undefined) setSelected(next);
          break;
        }
        case "o": {
          const url = selected === null ? undefined : byId.get(selected)?.applyUrl;
          const href = url === undefined ? undefined : safeHref(url);
          if (href !== undefined) window.open(href, "_blank", "noopener,noreferrer");
          break;
        }
        case "i":
        case "a":
        case "l": {
          const action = KEY_ACTIONS[e.key];
          if (action !== undefined) void act(action);
          break;
        }
        case "x":
          if (targets().length > 0) setAwaitingReason(true);
          break;
        case "s":
          void sendScam();
          break;
        case "u":
          void undo();
          break;
        case "?":
          setHelp((h) => !h);
          break;
        case "Escape":
          setHelp(false);
          break;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onCheck = useCallback((ids: string[], value: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (value) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const submitBulkNotInterested = () => {
    if (bulkReason === "") return setError("Pick a reason.");
    const note = bulkNote.trim();
    if (bulkReason === "other" && note === "") return setError("A note is required for other.");
    void act("not_interested", bulkReason, note);
  };

  return (
    <div className="queue">
      <p className="progress" role="status" aria-label="Progress">
        {processed} of {matches} processed
      </p>
      {live && <ElapsedTimer since={queue.firstReviewAt} now={now} />}
      <label>
        <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />{" "}
        Open only
      </label>{" "}
      <button type="button" aria-expanded={help} onClick={() => setHelp((h) => !h)}>
        Shortcuts (?)
      </button>
      {help && (
        <section aria-label="Keyboard shortcuts" className="help">
          <dl>
            {SHORTCUTS.map(([keys, what]) => (
              <div key={keys}>
                <dt>
                  <kbd>{keys}</kbd>
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {awaitingReason && (
        <p role="status" aria-label="Not interested reason">
          Not interested: press{" "}
          {Object.entries(REASON_KEYS)
            .map(([k, r]) => `${k} ${label(r)}`)
            .join(", ")}
          . Any other key cancels.
        </p>
      )}
      {checked.size > 0 && (
        <div className="form" role="group" aria-label="Bulk actions">
          <p>{checked.size} selected</p>
          <label>
            Reason
            <select
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value as NotInterestedReason | "")}
            >
              <option value="">Choose a reason</option>
              {NOT_INTERESTED_REASONS.map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </select>
          </label>
          {bulkReason === "other" && (
            <label>
              Note (required)
              <textarea
                value={bulkNote}
                maxLength={2000}
                onChange={(e) => setBulkNote(e.target.value)}
              />
            </label>
          )}
          <div className="actions">
            <button type="button" onClick={submitBulkNotInterested}>
              Not interested ({checked.size})
            </button>
            <button type="button" onClick={() => setChecked(new Set())}>
              Clear selection
            </button>
          </div>
        </div>
      )}
      {last !== null && (
        <p role="status" aria-label="Undo">
          Recorded {last.what}.{" "}
          <button type="button" onClick={() => void undo()}>
            Undo (u)
          </button>
        </p>
      )}
      {error !== null && <p role="alert">{error}</p>}
      {total === 0 && <p className="empty">No postings in the queue for this day. ({day})</p>}
      <div className="queue-layout">
        <div className="sections">
          {SECTIONS.map((s) => {
            if (queue.sections[s.key].length === 0) return null;
            const rows = rowsOf(s.key);
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
                    checked={checked}
                    onCheck={onCheck}
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

export function QueueTab({ day, now = () => new Date() }: { day: string; now?: () => Date }) {
  const q = useQuery({ queryKey: ["queue", day], queryFn: () => api.queue(day) });
  if (q.isPending) return <p>Loading...</p>;
  if (q.isError) return <p role="alert">Could not load the queue.</p>;
  return <QueueView day={day} queue={q.data} now={now} />;
}
