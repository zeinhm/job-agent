import { useQuery } from "@tanstack/react-query";
import { api, type Stats } from "../api.ts";

const TIERS = ["indonesia", "regional", "global_adjusted", "global_flat"] as const;

const counts = (o: Record<string, number>): string =>
  Object.entries(o)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "none";

export function doneWhenLine(s: Pick<Stats, "elapsedMinutes" | "matches" | "doneWhenMet">): string {
  return `done-when: ${s.elapsedMinutes} min for ${s.matches} matches (${s.doneWhenMet ? "met" : "not met"})`;
}

export function StatsTab({ day }: { day: string }) {
  const q = useQuery({ queryKey: ["stats", day], queryFn: () => api.stats(day) });
  if (q.isPending) return <p>Loading...</p>;
  if (q.isError) return <p role="alert">Could not load the stats.</p>;
  const s = q.data;

  return (
    <div className="stats">
      <p role="status" aria-label="Done-when">
        {doneWhenLine(s)}
      </p>
      <ul aria-label="Day numbers">
        <li>
          Matches: {s.matches}, processed: {s.processed}, open: {s.open}
        </li>
        <li>
          First review: {s.firstReviewAt ?? "-"}, last review: {s.lastReviewAt ?? "-"}
        </li>
        <li>
          Elapsed: {s.elapsedMinutes} min, median per processed posting:{" "}
          {s.medianSecondsPerPosting === null ? "-" : `${s.medianSecondsPerPosting} s`}
        </li>
        <li>Actions: {counts(s.actions)}</li>
        <li>Not interested reasons: {counts(s.reasons)}</li>
      </ul>
      <h3>Ask checks (target {s.askChecks.target} per tier)</h3>
      <table aria-label="Ask checks">
        <thead>
          <tr>
            <th>Tier</th>
            <th>ok</th>
            <th>too_high</th>
            <th>too_low</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {TIERS.map((t) => {
            const c = s.askChecks[t];
            return (
              <tr key={t}>
                <td>{t}</td>
                <td>{c.ok}</td>
                <td>{c.too_high}</td>
                <td>{c.too_low}</td>
                <td>
                  {c.total}/{s.askChecks.target}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3>Last 7 days</h3>
      <table aria-label="Last 7 days">
        <thead>
          <tr>
            <th>Day</th>
            <th>Matches</th>
            <th>Processed</th>
            <th>Open</th>
            <th>Elapsed (min)</th>
            <th>Done-when</th>
          </tr>
        </thead>
        <tbody>
          {s.week.map((w) => (
            <tr key={w.date}>
              <td>{w.date}</td>
              <td>{w.matches}</td>
              <td>{w.processed}</td>
              <td>{w.open}</td>
              <td>{w.elapsedMinutes}</td>
              <td>{w.doneWhenMet ? "met" : "not met"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
