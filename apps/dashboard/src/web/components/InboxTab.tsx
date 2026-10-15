import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ANSWER_TYPES, api, type Answer, type InboxAnswerBody, type InboxItem } from "../api.ts";

const NAME = /^[A-Za-z0-9_-]+$/;

function AnswerForm({
  item,
  busy,
  onSave,
}: {
  item: InboxItem;
  busy: boolean;
  onSave: (body: InboxAnswerBody) => void;
}) {
  const [group, setGroup] = useState("");
  const [key, setKey] = useState("");
  const [type, setType] = useState<InboxAnswerBody["type"]>("text");
  const [answer, setAnswer] = useState("");
  const [choicesText, setChoicesText] = useState("");
  const [approve, setApprove] = useState(false);
  const choices = choicesText
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c !== "");
  const label = (name: string) => `${name} for ${item.label}`;

  const answerOk =
    answer.trim() !== "" &&
    (type !== "number" || Number.isFinite(Number(answer))) &&
    (type !== "choice" || choices.includes(answer));
  const valid = NAME.test(group) && NAME.test(key) && answerOk;

  return (
    <form
      aria-label={`Answer ${item.label}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          group,
          key,
          type,
          answer: type === "yes_no" || type === "choice" ? answer : answer.trim(),
          ...(type === "choice" ? { choices } : {}),
          approved: approve,
        });
      }}
    >
      <input
        placeholder="group"
        aria-label={label("Group")}
        value={group}
        onChange={(e) => setGroup(e.target.value)}
      />{" "}
      <input
        placeholder="key"
        aria-label={label("Key")}
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />{" "}
      <select
        aria-label={label("Type")}
        value={type}
        onChange={(e) => {
          setType(e.target.value as InboxAnswerBody["type"]);
          setAnswer("");
        }}
      >
        {ANSWER_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>{" "}
      {type === "choice" && (
        <input
          placeholder="choices, comma separated"
          aria-label={label("Choices")}
          value={choicesText}
          onChange={(e) => setChoicesText(e.target.value)}
        />
      )}{" "}
      {type === "yes_no" ? (
        <select
          aria-label={label("Answer")}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        >
          <option value="">choose</option>
          <option value="yes">yes</option>
          <option value="no">no</option>
        </select>
      ) : type === "choice" ? (
        <select
          aria-label={label("Answer")}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        >
          <option value="">choose</option>
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : type === "number" ? (
        <input
          type="number"
          aria-label={label("Answer")}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
      ) : (
        <textarea
          aria-label={label("Answer")}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
      )}{" "}
      <label>
        <input
          type="checkbox"
          checked={approve}
          aria-label={label("Approve")}
          onChange={(e) => setApprove(e.target.checked)}
        />{" "}
        approve
      </label>{" "}
      <button type="submit" disabled={busy || !valid}>
        Save answer
      </button>
    </form>
  );
}

function LinkPicker({
  answers,
  busy,
  onLink,
}: {
  answers: Answer[];
  busy: boolean;
  onLink: (key: string) => void;
}) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const found = answers.filter(
    (a) =>
      needle === "" ||
      a.key.toLowerCase().includes(needle) ||
      (a.question ?? "").toLowerCase().includes(needle),
  );
  return (
    <div>
      <input
        type="search"
        placeholder="search answers"
        aria-label="Search answers"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {found.length === 0 ? (
        <p className="empty">No matching answers.</p>
      ) : (
        <ul aria-label="Matching answers">
          {found.map((a) => (
            <li key={a.key}>
              {a.key} <small>{a.question ?? "no question wording"}</small>{" "}
              <button
                type="button"
                disabled={busy}
                aria-label={`Link to ${a.key}`}
                onClick={() => onLink(a.key)}
              >
                Link
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InboxRow({
  item,
  answers,
  busy,
  act,
}: {
  item: InboxItem;
  answers: Answer[];
  busy: boolean;
  act: {
    answer: (body: InboxAnswerBody) => void;
    link: (key: string) => void;
    dismiss: () => void;
  };
}) {
  const [mode, setMode] = useState<"answer" | "link" | null>(null);
  return (
    <li aria-label={item.label}>
      <div>
        <strong>{item.label}</strong>{" "}
        <small>
          asked by {item.postingCount} {item.postingCount === 1 ? "posting" : "postings"}
        </small>
      </div>
      <ul aria-label={`Examples for ${item.label}`}>
        {item.examples.map((e) => (
          <li key={e.postingId}>
            {e.title} at {e.company}
          </li>
        ))}
      </ul>
      {item.salary ? (
        <p>Answered by the tier ask, stays in review.</p>
      ) : (
        <>
          <button
            type="button"
            aria-label={`Answer ${item.label}`}
            onClick={() => setMode(mode === "answer" ? null : "answer")}
          >
            Answer
          </button>{" "}
          <button
            type="button"
            aria-label={`Link ${item.label} to an existing answer`}
            onClick={() => setMode(mode === "link" ? null : "link")}
          >
            Link to existing
          </button>{" "}
        </>
      )}
      <button
        type="button"
        disabled={busy}
        aria-label={`Dismiss ${item.label}`}
        onClick={act.dismiss}
      >
        Dismiss
      </button>
      {mode === "answer" && <AnswerForm item={item} busy={busy} onSave={act.answer} />}
      {mode === "link" && <LinkPicker answers={answers} busy={busy} onLink={act.link} />}
    </li>
  );
}

export function InboxTab() {
  const client = useQueryClient();
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: api.inbox });
  const answers = useQuery({ queryKey: ["answers"], queryFn: api.answers });

  // Matching re-ran on the server: the answer bank, the inbox and the queue's question counts all moved.
  const done = () =>
    Promise.all(
      ["inbox", "answers", "queue", "posting"].map((k) =>
        client.invalidateQueries({ queryKey: [k] }),
      ),
    );
  const answer = useMutation({
    mutationFn: ({ id, body }: { id: string; body: InboxAnswerBody }) => api.answerInbox(id, body),
    onSuccess: done,
  });
  const link = useMutation({
    mutationFn: ({ id, key }: { id: string; key: string }) => api.linkInbox(id, key),
    onSuccess: done,
  });
  const dismiss = useMutation({ mutationFn: api.dismissInbox, onSuccess: done });

  if (inbox.isPending) return <p>Loading...</p>;
  if (inbox.isError) return <p role="alert">Could not load the inbox.</p>;

  const busy = answer.isPending || link.isPending || dismiss.isPending;
  const failed = answer.isError || link.isError || dismiss.isError;
  const { items, openCount } = inbox.data;

  return (
    <div className="inbox">
      <p role="status">Open questions: {openCount}</p>
      {failed && <p role="alert">That action could not be saved.</p>}
      {items.length === 0 ? (
        <p className="empty">No unknown questions.</p>
      ) : (
        <ul aria-label="Unknown questions">
          {items.map((item) => (
            <InboxRow
              key={item.id}
              item={item}
              answers={answers.data ?? []}
              busy={busy}
              act={{
                answer: (body) => answer.mutate({ id: item.id, body }),
                link: (key) => link.mutate({ id: item.id, key }),
                dismiss: () => dismiss.mutate(item.id),
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
