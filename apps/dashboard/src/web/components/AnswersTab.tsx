import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { api, type Answer, type AnswerPatchBody, type ChoiceMapping } from "../api.ts";

const features = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel() });
const helper = createColumnHelper<typeof features, Answer>();

/** Everything an inline edit can change, plus the add/remove alternatives controls, for one row. */
function AnswerCells({
  answer,
  mappings,
  save,
  removeMapping,
  busy,
}: {
  answer: Answer;
  mappings: ChoiceMapping[];
  save: (key: string, patch: AnswerPatchBody) => void;
  removeMapping: (m: ChoiceMapping) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(answer.answer);
  const [question, setQuestion] = useState(answer.question ?? "");
  const [phrasing, setPhrasing] = useState("");
  const alternatives = answer.alternatives ?? [];

  return (
    <>
      <td>
        <div>{answer.key}</div>
        {editing ? (
          <label>
            Question
            <input
              value={question}
              aria-label={`Question for ${answer.key}`}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </label>
        ) : (
          <small>{answer.question ?? "no question wording"}</small>
        )}
      </td>
      <td>
        {editing ? (
          <>
            <textarea
              aria-label={`Answer for ${answer.key}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || text.trim() === ""}
              onClick={() => {
                save(answer.key, {
                  answer: text,
                  question: question.trim() === "" ? null : question,
                });
                setEditing(false);
              }}
            >
              Save {answer.key}
            </button>{" "}
            <button
              type="button"
              onClick={() => {
                setText(answer.answer);
                setQuestion(answer.question ?? "");
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <span className="answer-text">{answer.answer}</span>{" "}
            <button type="button" onClick={() => setEditing(true)}>
              Edit {answer.key}
            </button>
          </>
        )}
      </td>
      <td>{answer.type ?? "-"}</td>
      <td>
        <label>
          <input
            type="checkbox"
            checked={answer.approved}
            disabled={busy}
            aria-label={`Approved ${answer.key}`}
            onChange={(e) => save(answer.key, { approved: e.target.checked })}
          />{" "}
          approved
        </label>
        {!answer.approved && (
          <div>
            <small>needs approval</small>
          </div>
        )}
      </td>
      <td>
        <ul aria-label={`Alternatives for ${answer.key}`}>
          {alternatives.map((alt, i) => (
            <li key={`${i}-${alt}`}>
              {alt}{" "}
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove alternative ${alt}`}
                onClick={() =>
                  save(answer.key, {
                    alternatives: alternatives.filter((_, j) => j !== i),
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <input
          value={phrasing}
          aria-label={`New alternative for ${answer.key}`}
          onChange={(e) => setPhrasing(e.target.value)}
        />{" "}
        <button
          type="button"
          disabled={busy || phrasing.trim() === ""}
          onClick={() => {
            save(answer.key, { alternatives: [...alternatives, phrasing.trim()] });
            setPhrasing("");
          }}
        >
          Add alternative to {answer.key}
        </button>
      </td>
      <td>
        <ul aria-label={`Choice mappings for ${answer.key}`}>
          {mappings.map((m) => (
            <li key={m.optionsHash}>
              {m.normalizedLabel}: <span className="answer-text">{m.chosen.join(", ")}</span>
              {!m.approved && (
                <>
                  {" "}
                  <small>needs approval, save it again in the Inbox</small>
                </>
              )}{" "}
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove mapping ${m.normalizedLabel} for ${answer.key}`}
                onClick={() => removeMapping(m)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </td>
    </>
  );
}

function AddAnswer({
  onAdd,
  busy,
}: {
  onAdd: (g: string, k: string, a: string) => void;
  busy: boolean;
}) {
  const [group, setGroup] = useState("");
  const [key, setKey] = useState("");
  const [answer, setAnswer] = useState("");
  const valid =
    /^[A-Za-z0-9_-]+$/.test(group) && /^[A-Za-z0-9_-]+$/.test(key) && answer.trim() !== "";
  return (
    <form
      aria-label="Add answer"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd(group, key, answer);
        setGroup("");
        setKey("");
        setAnswer("");
      }}
    >
      <input
        placeholder="group"
        aria-label="New group"
        value={group}
        onChange={(e) => setGroup(e.target.value)}
      />{" "}
      <input
        placeholder="key"
        aria-label="New key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />{" "}
      <input
        placeholder="answer"
        aria-label="New answer"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
      />{" "}
      <button type="submit" disabled={busy || !valid}>
        Add answer
      </button>
    </form>
  );
}

export function AnswersTab() {
  const client = useQueryClient();
  const [onlyUnapproved, setOnlyUnapproved] = useState(false);
  const [exported, setExported] = useState<{ path: string; count: number } | null>(null);
  const q = useQuery({ queryKey: ["answers"], queryFn: api.answers });

  const mappingsQuery = useQuery({ queryKey: ["choice-mappings"], queryFn: api.choiceMappings });

  const refresh = () => client.invalidateQueries({ queryKey: ["answers"] });
  // An edit can clear an answer's approval and with it its mappings, which moves the inbox and the queue counts.
  const refreshAll = () =>
    Promise.all(
      ["answers", "choice-mappings", "inbox", "queue", "posting"].map((k) =>
        client.invalidateQueries({ queryKey: [k] }),
      ),
    );
  const removeMapping = useMutation({
    mutationFn: (m: ChoiceMapping) =>
      api.removeChoiceMapping({
        answer_key: m.answerKey,
        label: m.normalizedLabel,
        options: m.options,
      }),
    onSuccess: refreshAll,
  });
  const patch = useMutation({
    mutationFn: ({ key, body }: { key: string; body: AnswerPatchBody }) =>
      api.patchAnswer(key, body),
    onSuccess: refreshAll,
  });
  const add = useMutation({ mutationFn: api.createAnswer, onSuccess: refresh });
  const exportMut = useMutation({ mutationFn: api.exportAnswers, onSuccess: setExported });

  const rows = useMemo(
    () => (q.data ?? []).filter((a) => !onlyUnapproved || !a.approved),
    [q.data, onlyUnapproved],
  );
  const columns = useMemo(
    () => helper.columns([helper.accessor("group", { header: "Group" })]),
    [],
  );
  // Rows arrive sorted by group then key; the table keeps that order and group headings are drawn on change.
  const table = useTable({ features, columns, data: rows });

  if (q.isPending) return <p>Loading...</p>;
  if (q.isError) return <p role="alert">Could not load the answers.</p>;

  const failed = patch.isError || add.isError || exportMut.isError || removeMapping.isError;
  const busy = patch.isPending || add.isPending || removeMapping.isPending;
  const shown = table.getRowModel().rows;

  return (
    <div className="answers">
      <p>
        <label>
          <input
            type="checkbox"
            checked={onlyUnapproved}
            onChange={(e) => setOnlyUnapproved(e.target.checked)}
          />{" "}
          Not approved only
        </label>{" "}
        <button type="button" disabled={exportMut.isPending} onClick={() => exportMut.mutate()}>
          Export YAML
        </button>
      </p>
      {exported !== null && (
        <p role="status">
          Exported {exported.count} answers to {exported.path}
        </p>
      )}
      {failed && <p role="alert">That change could not be saved.</p>}
      <AddAnswer busy={busy} onAdd={(group, key, answer) => add.mutate({ group, key, answer })} />
      {shown.length === 0 ? (
        <p className="empty">{onlyUnapproved ? "Every answer is approved." : "No answers yet."}</p>
      ) : (
        <table aria-label="Answers">
          <thead>
            <tr>
              <th>Key / question</th>
              <th>Answer</th>
              <th>Type</th>
              <th>Approval</th>
              <th>Alternatives</th>
              <th>Choice mappings</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => {
              const a = row.original;
              const newGroup = i === 0 || shown[i - 1]?.original.group !== a.group;
              return (
                <Fragment key={row.id}>
                  {newGroup && (
                    <tr className="group-row">
                      <th colSpan={6} scope="colgroup">
                        {a.group}
                      </th>
                    </tr>
                  )}
                  <tr>
                    <AnswerCells
                      // Remounts when the saved row changes so edit boxes never show stale text.
                      key={`${a.key}-${a.updatedAt}`}
                      answer={a}
                      mappings={(mappingsQuery.data ?? []).filter((m) => m.answerKey === a.key)}
                      busy={busy}
                      save={(key, body) => patch.mutate({ key, body })}
                      removeMapping={(m) => removeMapping.mutate(m)}
                    />
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
