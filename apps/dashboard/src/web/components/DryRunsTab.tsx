import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, DRY_RUN_REVIEW_REASONS, type DryRunDetail, type DryRunReviewBody } from "../api.ts";

type Reason = (typeof DRY_RUN_REVIEW_REASONS)[number];

function ReviewForm({ run, onDone }: { run: DryRunDetail; onDone: () => void }) {
  const qc = useQueryClient();
  const [wrong, setWrong] = useState(run.review === "wrong");
  const [reason, setReason] = useState<Reason | "">(
    DRY_RUN_REVIEW_REASONS.find((r) => r === run.reviewReason) ?? "",
  );
  const [note, setNote] = useState(run.reviewNote ?? "");
  const [missing, setMissing] = useState("");
  const save = useMutation({
    mutationFn: (body: DryRunReviewBody) => api.reviewDryRun(run.id, body),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["dry-runs"] });
      await qc.invalidateQueries({ queryKey: ["dry-run", run.id] });
      await qc.invalidateQueries({ queryKey: ["stats"] });
      await qc.invalidateQueries({ queryKey: ["inbox"] });
      onDone();
    },
  });

  return (
    <div className="dry-run-review">
      <p>
        Review: {run.review ?? "not reviewed"}
        {run.reviewReason !== null ? ` (${run.reviewReason})` : ""}. A review can be changed; no
        history is kept.
      </p>
      <button
        type="button"
        disabled={save.isPending}
        onClick={() => save.mutate({ review: "correct" })}
      >
        Correct
      </button>{" "}
      <button type="button" aria-pressed={wrong} onClick={() => setWrong(true)}>
        Wrong
      </button>
      {wrong && (
        <form
          aria-label="Wrong reason"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason === "") return;
            save.mutate({
              review: "wrong",
              reason,
              ...(note.trim() !== "" ? { note: note.trim() } : {}),
              ...(reason === "missing_field" && missing.trim() !== ""
                ? { missing_label: missing.trim() }
                : {}),
            });
          }}
        >
          <select
            aria-label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value as Reason | "")}
          >
            <option value="">choose a reason</option>
            {DRY_RUN_REVIEW_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>{" "}
          {reason === "missing_field" && (
            <input
              aria-label="Missing field label"
              placeholder="label of the missing field"
              value={missing}
              onChange={(e) => setMissing(e.target.value)}
            />
          )}{" "}
          <input
            aria-label="Note"
            placeholder="note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />{" "}
          <button type="submit" disabled={reason === "" || save.isPending}>
            Save wrong
          </button>
        </form>
      )}
      {save.isError && <p role="alert">Could not save the review.</p>}
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const [shotFailed, setShotFailed] = useState(false);
  const q = useQuery({ queryKey: ["dry-run", id], queryFn: () => api.dryRun(id) });
  if (q.isPending) return <p>Loading...</p>;
  if (q.isError) return <p role="alert">Could not load the dry run.</p>;
  const run = q.data;
  return (
    <section aria-label="Dry run detail">
      <h3>
        {run.title} at {run.company}
      </h3>
      <p>
        Stop: {run.stopReason ?? "none"}
        {run.stopDetail !== null ? `, ${run.stopDetail}` : ""}. Blocked requests recorded:{" "}
        {run.blockedRequestsRecorded}.
      </p>
      {run.hasScreenshot && !shotFailed ? (
        <img
          alt="Dry run screenshot"
          src={api.dryRunScreenshotUrl(run.id)}
          style={{ maxWidth: "100%" }}
          onError={() => setShotFailed(true)}
        />
      ) : (
        <p>No screenshot available.</p>
      )}
      <table aria-label="Filled fields">
        <thead>
          <tr>
            <th>Label</th>
            <th>Value</th>
            <th>Source</th>
            <th>Answer key</th>
            <th>Filled</th>
          </tr>
        </thead>
        <tbody>
          {run.fields.map((f, i) => (
            <tr key={`${i}-${f.label}`}>
              <td>{f.label}</td>
              <td>{f.value ?? "-"}</td>
              <td>{f.source}</td>
              <td>{f.answerKey ?? "-"}</td>
              <td>{f.filled ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ReviewForm key={`${run.id}-${run.reviewedAt ?? ""}`} run={run} onDone={() => undefined} />
    </section>
  );
}

export function DryRunsTab() {
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["dry-runs"], queryFn: () => api.dryRuns() });
  if (q.isPending) return <p>Loading...</p>;
  if (q.isError) return <p role="alert">Could not load the dry runs.</p>;
  const { runs, doneWhen } = q.data;
  return (
    <div className="dry-runs">
      <p role="status" aria-label="Dry-run done-when">
        {doneWhen.line}
      </p>
      {runs.length === 0 ? (
        <p>No dry runs yet. Run one from the command line.</p>
      ) : (
        <table aria-label="Dry runs">
          <thead>
            <tr>
              <th>Posting</th>
              <th>Company</th>
              <th>ATS</th>
              <th>Status</th>
              <th>Stop reason</th>
              <th>Fields</th>
              <th>Time</th>
              <th>Review</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{r.title}</td>
                <td>{r.company}</td>
                <td>{r.atsType}</td>
                <td>{r.status}</td>
                <td>{r.stopReason ?? "-"}</td>
                <td>
                  {r.fieldsFilled}/{r.fieldsTotal}
                </td>
                <td>{r.startedAt}</td>
                <td>
                  {r.fixture ? "fixture" : (r.review ?? "open")}
                  {r.review === "wrong" && r.reviewReason !== null ? ` (${r.reviewReason})` : ""}
                </td>
                <td>
                  <button
                    type="button"
                    aria-label={`Open ${r.title} at ${r.company}`}
                    onClick={() => setOpen(open === r.id ? null : r.id)}
                  >
                    {open === r.id ? "Close" : "Open"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open !== null && <Detail id={open} />}
    </div>
  );
}
