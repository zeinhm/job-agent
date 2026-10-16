import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ASK_ACTIONS,
  api,
  NOT_INTERESTED_REASONS,
  PAY_POLICIES,
  SIMPLE_ACTIONS,
  type NotInterestedReason,
  type PostingDetail,
  type ReviewBody,
} from "../api.ts";
import { endSentence } from "@job-agent/core/sentence";
import { ExternalLink, safeHref } from "./ExternalLink.tsx";
import { reviewLabel } from "./SectionTable.tsx";

type Form = "not_interested" | "wrong_apply_link" | "pay_policy" | null;

const label = (s: string) => s.replaceAll("_", " ");

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h4>{title}</h4>
      <ul>
        {items.map((x, i) => (
          <li key={`${i}-${x}`}>{x}</li>
        ))}
      </ul>
    </section>
  );
}

function Actions({ detail }: { detail: PostingDetail }) {
  const client = useQueryClient();
  const [form, setForm] = useState<Form>(null);
  const [reason, setReason] = useState<NotInterestedReason | "">("");
  const [note, setNote] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: (body: ReviewBody) => api.review(body),
    onSuccess: async () => {
      setForm(null);
      setReason("");
      setNote("");
      setUrl("");
      setError(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["queue"] }),
        client.invalidateQueries({ queryKey: ["posting", detail.postingId] }),
      ]);
    },
    onError: () => setError("Saving failed. Nothing was recorded."),
  });
  const post = (body: Omit<ReviewBody, "posting_id">) => {
    setError(null);
    send.mutate({ posting_id: detail.postingId, ...body });
  };
  const open = (f: Form) => {
    setError(null);
    setForm(f);
  };

  const submitNotInterested = () => {
    if (reason === "") return setError("Pick a reason.");
    const trimmed = note.trim();
    if (reason === "other" && trimmed === "") return setError("A note is required for other.");
    post({ action: "not_interested", reason, ...(trimmed === "" ? {} : { note: trimmed }) });
  };
  const submitWrongLink = () => {
    const trimmed = url.trim();
    if (trimmed !== "" && safeHref(trimmed) === undefined)
      return setError("The corrected link must be an http or https URL.");
    post({ action: "wrong_apply_link", ...(trimmed === "" ? {} : { apply_url: trimmed }) });
  };

  return (
    <section aria-label="Actions">
      <h4>Actions</h4>
      <div className="actions">
        {SIMPLE_ACTIONS.map((a) => (
          <button
            key={a}
            type="button"
            disabled={send.isPending}
            onClick={() => post({ action: a })}
          >
            {label(a)}
          </button>
        ))}
        <button
          type="button"
          aria-expanded={form === "not_interested"}
          onClick={() => open("not_interested")}
        >
          not interested
        </button>
        <button
          type="button"
          aria-expanded={form === "wrong_apply_link"}
          onClick={() => open("wrong_apply_link")}
        >
          wrong apply link
        </button>
        <button
          type="button"
          aria-expanded={form === "pay_policy"}
          onClick={() => open("pay_policy")}
        >
          pay policy
        </button>
      </div>
      {detail.ask !== null && (
        <div className="actions" role="group" aria-label="Ask check">
          {ASK_ACTIONS.map((a) => (
            <button
              key={a}
              type="button"
              disabled={send.isPending}
              onClick={() => post({ action: a })}
            >
              {label(a)}
            </button>
          ))}
        </div>
      )}
      {form === "not_interested" && (
        <div className="form" role="group" aria-label="Not interested">
          <label>
            Reason
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as NotInterestedReason | "")}
            >
              <option value="">Choose a reason</option>
              {NOT_INTERESTED_REASONS.map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Note{reason === "other" ? " (required)" : " (optional)"}
            <textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="button" disabled={send.isPending} onClick={submitNotInterested}>
            Confirm not interested
          </button>
        </div>
      )}
      {form === "wrong_apply_link" && (
        <div className="form" role="group" aria-label="Wrong apply link">
          <label>
            Corrected apply URL (optional)
            <input
              type="text"
              value={url}
              maxLength={2000}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <button type="button" disabled={send.isPending} onClick={submitWrongLink}>
            Confirm wrong apply link
          </button>
        </div>
      )}
      {form === "pay_policy" && (
        <div className="form" role="group" aria-label="Pay policy">
          {PAY_POLICIES.map((p) => (
            <button
              key={p}
              type="button"
              disabled={send.isPending}
              onClick={() => post({ action: "pay_policy", pay_policy: p })}
            >
              {label(p)}
            </button>
          ))}
        </div>
      )}
      {error !== null && <p role="alert">{error}</p>}
    </section>
  );
}

function Body({ detail }: { detail: PostingDetail }) {
  return (
    <>
      <h3>
        {detail.title} <small>at {detail.company}</small>
      </h3>
      <p>
        Review: <strong>{reviewLabel(detail.review)}</strong> | Fit: {detail.fitScore ?? "-"} |
        Apply type: {detail.applyType}
      </p>
      <p>
        Location: {detail.locations.join(", ") || "unknown"} ({detail.locationClass})
      </p>
      <p>
        Apply link: <ExternalLink href={detail.applyUrl} />
      </p>
      {detail.ask !== null && <p>Ask: {detail.ask}</p>}
      {detail.askText !== null && <p>Text answer: {endSentence(detail.askText)}</p>}
      <List title="Fit reasons" items={detail.reasons.fit} />
      <List title="Flags" items={detail.flags} />
      <List
        title="Scam reasons"
        items={
          detail.reasons.scam.length > 0
            ? detail.reasons.scam
            : detail.scamReason === null
              ? []
              : [detail.scamReason]
        }
      />
      <Actions key={detail.postingId} detail={detail} />
      <section>
        <h4>Description</h4>
        <pre className="description">{detail.descriptionText ?? "No description stored."}</pre>
      </section>
      <section>
        <h4>Review history</h4>
        {detail.history.length === 0 ? (
          <p className="empty">No reviews yet.</p>
        ) : (
          <ul>
            {detail.history.map((h) => (
              <li key={h.id}>
                {h.reviewed_at}: {label(h.action)}
                {h.reason !== null ? ` (${label(h.reason)})` : ""}
                {h.pay_policy !== null ? ` (${label(h.pay_policy)})` : ""}
                {h.apply_url !== null ? (
                  <>
                    {" "}
                    (<ExternalLink href={h.apply_url} />)
                  </>
                ) : (
                  ""
                )}
                {h.note !== null ? `: ${h.note}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function DetailPanel({ postingId, onClose }: { postingId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["posting", postingId], queryFn: () => api.posting(postingId) });
  return (
    <aside aria-label="Posting detail">
      <button type="button" onClick={onClose}>
        Close
      </button>
      {q.isPending && <p>Loading...</p>}
      {q.isError && <p role="alert">Could not load this posting.</p>}
      {q.data !== undefined && <Body detail={q.data} />}
    </aside>
  );
}
