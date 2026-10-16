import { eq } from "drizzle-orm";
import {
  answer_bank,
  choice_mappings,
  openDb,
  posting_questions,
  postings,
  type Db,
} from "@job-agent/core";
import { beforeEach, describe, expect, it } from "vitest";
import { importAnswers } from "./answers-import.ts";
import { updateAnswer } from "./answers-store.ts";
import { listMappingNeeds, saveChoiceMapping } from "./choice-mapping.ts";
import { DryRunStoreError, getChoiceMapping, removeChoiceMapping } from "./dry-runs-store.ts";
import { listInbox } from "./inbox.ts";
import { matchQuestions, questionCounts } from "./match-questions.ts";
import { normalizeQuestion } from "./match.ts";

let db: Db;
let n: number;
let q: number;
beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
  q = 0;
});

const OPTIONS = ["Immediately", "Within 1 month", "More than 1 month"];
const LABEL = "What is your notice period?";

function addPosting(): string {
  const id = `p${++n}`;
  db.insert(postings)
    .values({
      id,
      source: "greenhouse",
      external_id: id,
      url: `https://example.test/jobs/${id}`,
      title: `Engineer ${id}`,
      company_name: "Acme",
      first_seen_at: "2026-10-13T00:00:00.000Z",
      last_seen_at: "2026-10-13T00:00:00.000Z",
      normalized_at: "2026-10-13T00:00:00.000Z",
    })
    .run();
  return id;
}

function ask(postingId: string, label: string, type: string, options: string[] | null) {
  const id = `q${++q}`;
  db.insert(posting_questions)
    .values({
      id,
      posting_id: postingId,
      ats_type: "greenhouse",
      question_id: id,
      label,
      required: false,
      type,
      options: options === null ? null : JSON.stringify(options),
      normalized_label: normalizeQuestion(label),
      fetched_at: "2026-10-13T01:00:00.000Z",
    })
    .run();
}

function addAnswer(key: string, question: string, approved = true, answer = "FAKE-ANSWER") {
  db.insert(answer_bank)
    .values({
      id: key,
      key,
      group: key.split(".")[0] ?? "g",
      question,
      answer,
      approved,
      approved_at: approved ? "2026-10-13T00:00:00.000Z" : null,
      source: "dashboard",
      updated_at: "2026-10-13T00:00:00.000Z",
    })
    .run();
}

const save = (chosen: string[], over: { label?: string; options?: string[] } = {}) =>
  saveChoiceMapping(db, {
    answer_key: "work.notice",
    label: over.label ?? LABEL,
    options: over.options ?? OPTIONS,
    chosen,
  });

describe("coverage rule", () => {
  it("a choice question with an approved answer is not covered until an approved mapping exists", () => {
    addAnswer("work.notice", LABEL);
    const p = addPosting();
    ask(p, LABEL, "choice", OPTIONS);
    ask(p, "Email", "text", null);
    expect(matchQuestions(db)).toMatchObject({ covered: 1, needsMapping: 1, unknown: 0 });
    expect(questionCounts(db, [p]).get(p)).toEqual({
      total: 2,
      covered: 1,
      needsMapping: 1,
      unknown: 0,
      salary: 0,
    });
    save(["Within 1 month"]);
    expect(matchQuestions(db)).toMatchObject({ covered: 2, needsMapping: 0 });
    expect(questionCounts(db, [p]).get(p)).toMatchObject({ covered: 2, needsMapping: 0 });
  });

  it("a mapping that is saved but not approved does not cover", () => {
    addAnswer("work.notice", LABEL);
    const p = addPosting();
    ask(p, LABEL, "choice", OPTIONS);
    matchQuestions(db);
    save(["Immediately"]);
    db.update(choice_mappings).set({ approved: false, approved_at: null }).run();
    expect(matchQuestions(db)).toMatchObject({ covered: 0, needsMapping: 1 });
    expect(questionCounts(db, [p]).get(p)).toMatchObject({ covered: 0, needsMapping: 1 });
  });

  it("text and yes/no questions never need a mapping; multi-choice does", () => {
    addAnswer("work.notice", LABEL);
    const p = addPosting();
    ask(p, LABEL, "text", null);
    expect(matchQuestions(db)).toMatchObject({ covered: 1, needsMapping: 0 });
    const p2 = addPosting();
    ask(p2, LABEL, "multi_choice", OPTIONS);
    expect(matchQuestions(db)).toMatchObject({ covered: 1, needsMapping: 1 });
  });

  it("the same wording and option set is covered on every form, in any option order or case", () => {
    addAnswer("work.notice", LABEL);
    const a = addPosting();
    const b = addPosting();
    ask(a, LABEL, "choice", OPTIONS);
    ask(
      b,
      "What is your notice period",
      "choice",
      [...OPTIONS].reverse().map((o) => o.toUpperCase()),
    );
    expect(matchQuestions(db).needsMapping).toBe(2);
    save(["Immediately"]);
    expect(matchQuestions(db)).toMatchObject({ covered: 2, needsMapping: 0 });
  });

  it("a changed option set is a new mapping; the old one stays", () => {
    addAnswer("work.notice", LABEL);
    const a = addPosting();
    const b = addPosting();
    ask(a, LABEL, "choice", OPTIONS);
    matchQuestions(db);
    save(["Immediately"]);
    ask(b, LABEL, "choice", [...OPTIONS, "Not applicable"]);
    expect(matchQuestions(db)).toMatchObject({ covered: 1, needsMapping: 1 });
    expect(questionCounts(db, [b]).get(b)).toMatchObject({ covered: 0, needsMapping: 1 });
    expect(listMappingNeeds(db).map((x) => x.options)).toEqual([[...OPTIONS, "Not applicable"]]);
    save(["Not applicable"], { options: [...OPTIONS, "Not applicable"] });
    expect(db.select().from(choice_mappings).all()).toHaveLength(2);
    expect(matchQuestions(db)).toMatchObject({ covered: 2, needsMapping: 0 });
  });

  it("an unapproved answer leaves the question in the inbox, not in needs-a-mapping", () => {
    addAnswer("work.notice", LABEL, false);
    ask(addPosting(), LABEL, "choice", OPTIONS);
    expect(matchQuestions(db)).toMatchObject({ covered: 0, needsMapping: 0, unknown: 1 });
    expect(listInbox(db).mappings).toEqual([]);
  });
});

describe("listMappingNeeds", () => {
  it("shows the options as the form lists them, the answer text, counts and a pre-existing pick", () => {
    addAnswer("work.notice", LABEL, true, "Within 1 month");
    const a = addPosting();
    const b = addPosting();
    ask(a, LABEL, "choice", OPTIONS);
    ask(b, LABEL, "choice", OPTIONS);
    matchQuestions(db);
    const needs = listMappingNeeds(db);
    expect(needs).toEqual([
      {
        answerKey: "work.notice",
        label: LABEL,
        normalizedLabel: "what is your notice period",
        options: OPTIONS,
        multi: false,
        answerText: "Within 1 month",
        postingCount: 2,
        examples: [
          { postingId: "p1", title: "Engineer p1", company: "Acme" },
          { postingId: "p2", title: "Engineer p2", company: "Acme" },
        ],
        picked: null,
      },
    ]);
    expect(listInbox(db).mappings).toEqual(needs);
  });

  it("a mapping whose approval was cleared comes back with its pick; saving it again approves it", () => {
    addAnswer("work.notice", LABEL);
    ask(addPosting(), LABEL, "choice", OPTIONS);
    matchQuestions(db);
    save(["Immediately"]);
    updateAnswer(db, "work.notice", { answer: "FAKE-OTHER" });
    updateAnswer(db, "work.notice", { approved: true });
    matchQuestions(db);
    expect(listMappingNeeds(db)[0]?.picked).toEqual(["Immediately"]);
    save(["Immediately"]);
    expect(listMappingNeeds(db)).toEqual([]);
  });
});

describe("saveChoiceMapping", () => {
  beforeEach(() => {
    addAnswer("work.notice", LABEL);
    ask(addPosting(), LABEL, "choice", OPTIONS);
    ask(addPosting(), "Which of these do you use?", "multi_choice", ["A", "B", "C"]);
    matchQuestions(db);
  });

  it("stores an approved mapping and re-matches", () => {
    const m = save(["Within 1 month"]);
    expect(m).toMatchObject({ approved: true, chosen: ["Within 1 month"] });
    expect(
      getChoiceMapping(db, { answer_key: "work.notice", label: LABEL, options: OPTIONS })?.approved,
    ).toBe(true);
  });

  it("a single-choice question takes exactly one option; a multi-choice one takes several", () => {
    expect(() => save(["Immediately", "Within 1 month"])).toThrow(DryRunStoreError);
    addAnswer("tools.used", "Which of these do you use?");
    matchQuestions(db);
    const multi = saveChoiceMapping(db, {
      answer_key: "tools.used",
      label: "Which of these do you use?",
      options: ["A", "B", "C"],
      chosen: ["A", "C"],
    });
    expect(multi.chosen).toEqual(["A", "C"]);
  });

  it("refuses an option the stored form does not list, and duplicates", () => {
    expect(() => save(["Tomorrow"])).toThrowError(
      expect.objectContaining({ kind: "invalid", paths: ["chosen"] }),
    );
    expect(() => save([OPTIONS[0] as string, OPTIONS[0] as string])).toThrow(DryRunStoreError);
    expect(db.select().from(choice_mappings).all()).toHaveLength(0);
  });

  it("checks the pick against the stored options, not the options in the request", () => {
    // The request claims an extra option; the stored form has the same hash only if the sets are equal, so it is unknown.
    expect(() => save(["Extra"], { options: [...OPTIONS, "Extra"] })).toThrowError(
      expect.objectContaining({ kind: "not_found" }),
    );
  });

  it("refuses a salary wording (invalid) even when a stored question has it", () => {
    ask(addPosting(), "Expected salary?", "choice", ["Low", "High"]);
    addAnswer("pay.any", "Expected salary?");
    matchQuestions(db);
    expect(() =>
      saveChoiceMapping(db, {
        answer_key: "pay.any",
        label: "Expected salary?",
        options: ["Low", "High"],
        chosen: ["Low"],
      }),
    ).toThrowError(expect.objectContaining({ kind: "invalid", paths: ["label"] }));
    expect(db.select().from(choice_mappings).all()).toHaveLength(0);
  });

  it("is not_found for an unknown question, an unapproved answer or another answer's question", () => {
    expect(() => save(["Immediately"], { label: "Something else?" })).toThrowError(
      expect.objectContaining({ kind: "not_found" }),
    );
    updateAnswer(db, "work.notice", { approved: false });
    expect(() => save(["Immediately"])).toThrowError(
      expect.objectContaining({ kind: "not_found" }),
    );
  });

  it("never maps by itself: an option equal to the answer text stays unmapped", () => {
    db.update(answer_bank)
      .set({ answer: "Immediately" })
      .where(eq(answer_bank.key, "work.notice"))
      .run();
    matchQuestions(db);
    expect(db.select().from(choice_mappings).all()).toHaveLength(0);
    expect(listMappingNeeds(db)[0]?.picked).toBeNull();
  });
});

describe("approval clearing (F3)", () => {
  beforeEach(() => {
    addAnswer("work.notice", LABEL);
    ask(addPosting(), LABEL, "choice", OPTIONS);
    matchQuestions(db);
    save(["Immediately"]);
  });
  const mapping = () => db.select().from(choice_mappings).get();

  it("editing the answer clears its mappings' approval, keeping the pick", () => {
    updateAnswer(db, "work.notice", { answer: "FAKE-CHANGED" });
    expect(mapping()).toMatchObject({
      approved: false,
      approved_at: null,
      chosen: '["Immediately"]',
    });
    // Re-approving the answer does not bring the mapping back.
    updateAnswer(db, "work.notice", { approved: true });
    expect(mapping()?.approved).toBe(false);
    expect(matchQuestions(db)).toMatchObject({ covered: 0, needsMapping: 1 });
  });

  it("unticking approval, or changing wording / alternatives, clears it", () => {
    updateAnswer(db, "work.notice", { approved: false });
    expect(mapping()?.approved).toBe(false);
    updateAnswer(db, "work.notice", { approved: true });
    matchQuestions(db);
    save(["Immediately"]);
    expect(mapping()?.approved).toBe(true);
    updateAnswer(db, "work.notice", { alternatives: ["Notice?"] });
    expect(mapping()?.approved).toBe(false);
  });

  it("a no-op patch keeps the mapping approved", () => {
    updateAnswer(db, "work.notice", { answer: "FAKE-ANSWER", approved: true });
    expect(mapping()?.approved).toBe(true);
  });

  it("only that answer's mappings are cleared", () => {
    addAnswer("work.other", "Other?");
    db.insert(choice_mappings)
      .values({
        id: "m2",
        answer_key: "work.other",
        normalized_label: "other",
        options_hash: "h",
        options: "[]",
        chosen: "[]",
        approved: true,
        approved_at: "2026-10-13T00:00:00.000Z",
        updated_at: "2026-10-13T00:00:00.000Z",
      })
      .run();
    updateAnswer(db, "work.notice", { answer: "FAKE-CHANGED" });
    expect(
      db.select().from(choice_mappings).where(eq(choice_mappings.id, "m2")).get()?.approved,
    ).toBe(true);
  });

  it("a config import that withdraws approval clears the mappings too", () => {
    db.update(answer_bank).set({ source: "config" }).run();
    importAnswers(
      db,
      [
        {
          key: "work.notice",
          group: "work",
          question: LABEL,
          answer: "FAKE-ANSWER",
          type: null,
          choices: null,
          alternatives: null,
          approved: false,
        },
      ],
      () => {},
    );
    expect(mapping()?.approved).toBe(false);
  });
});

describe("removeChoiceMapping", () => {
  it("deletes one mapping and the question needs a mapping again", () => {
    addAnswer("work.notice", LABEL);
    ask(addPosting(), LABEL, "choice", OPTIONS);
    matchQuestions(db);
    save(["Immediately"]);
    expect(
      removeChoiceMapping(db, { answer_key: "work.notice", label: LABEL, options: OPTIONS }),
    ).toBe(true);
    expect(
      removeChoiceMapping(db, { answer_key: "work.notice", label: LABEL, options: OPTIONS }),
    ).toBe(false);
    expect(matchQuestions(db)).toMatchObject({ needsMapping: 1, covered: 0 });
  });
});
