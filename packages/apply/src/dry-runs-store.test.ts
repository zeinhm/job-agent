import { answer_bank, dry_run_fields, dry_runs, openDb, postings, type Db } from "@job-agent/core";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  DryRunStoreError,
  approveChoiceMapping,
  getChoiceMapping,
  getDryRun,
  listChoiceMappings,
  listDryRuns,
  optionsHash,
  recordDryRun,
  setChoiceMapping,
  setDryRunReview,
  type DryRunFieldInput,
  type NewDryRunInput,
} from "./dry-runs-store.ts";

const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-01T10:01:00.000Z";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  for (const id of ["p1", "p2"])
    db.insert(postings)
      .values({
        id,
        source: "greenhouse",
        external_id: id,
        url: `https://fake.example.com/jobs/${id}`,
        title: "Senior Backend Engineer",
        company_name: "Fake Co",
        first_seen_at: T0,
        last_seen_at: T0,
      })
      .run();
  db.insert(answer_bank)
    .values({
      id: "a1",
      key: "work.authorization",
      group: "work",
      answer: "Yes",
      source: "dashboard",
      updated_at: T0,
    })
    .run();
});

const NAME_FIELD: DryRunFieldInput = {
  label: "Full name",
  field_type: "input_text",
  required: true,
  source: "answer",
  answer_key: "identity.full_name",
  value: "Alex Example",
  filled: true,
};

const run = (over: Partial<NewDryRunInput> = {}): NewDryRunInput => ({
  posting_id: "p1",
  ats_type: "greenhouse",
  started_at: T0,
  finished_at: T1,
  status: "filled",
  fixture: true,
  fields: [
    NAME_FIELD,
    { label: "Resume", field_type: "file", required: true, source: "resume", filled: true },
  ],
  ...over,
});

describe("recordDryRun", () => {
  it("stores the run and its fields", () => {
    const id = recordDryRun(db, run({ screenshot_path: "dryruns/2026-10-01/r1/page.png" }));
    const got = getDryRun(db, id);
    expect(got?.run).toMatchObject({
      posting_id: "p1",
      status: "filled",
      stop_reason: null,
      screenshot_path: "dryruns/2026-10-01/r1/page.png",
      review: null,
      fixture: true,
    });
    expect(got?.fields.map((f) => [f.label, f.source, f.value, f.filled])).toEqual(
      expect.arrayContaining([
        ["Full name", "answer", "Alex Example", true],
        ["Resume", "resume", null, true],
      ]),
    );
  });

  it("writes nothing when a field insert fails (one transaction)", () => {
    // FK on posting fails on the run insert; a bad field insert is forced by dropping the fields table's parent row
    expect(() => recordDryRun(db, run({ posting_id: "missing" }))).toThrow(/FOREIGN KEY/);
    expect(db.select().from(dry_runs).all()).toEqual([]);
    expect(db.select().from(dry_run_fields).all()).toEqual([]);
    const trigger = db.$client;
    trigger.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON dry_run_fields WHEN NEW.label = 'Boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    const fields = [...run().fields, { ...NAME_FIELD, label: "Boom" }];
    expect(() => recordDryRun(db, run({ fields }))).toThrow(/boom/);
    expect(db.select().from(dry_runs).all()).toEqual([]);
    expect(db.select().from(dry_run_fields).all()).toEqual([]);
  });

  it("validates status and stop reason together", () => {
    expect(() => recordDryRun(db, run({ status: "filled", stop_reason: "captcha" }))).toThrow(
      ZodError,
    );
    expect(() => recordDryRun(db, run({ status: "stopped" }))).toThrow(ZodError);
    expect(() => recordDryRun(db, run({ status: "needs_input", stop_reason: "captcha" }))).toThrow(
      ZodError,
    );
    expect(() =>
      recordDryRun(db, run({ status: "needs_input", stop_reason: "page_error" })),
    ).toThrow(ZodError);
    expect(() =>
      recordDryRun(db, run({ status: "needs_input", stop_reason: "choice_unmapped" })),
    ).not.toThrow();
    expect(() =>
      recordDryRun(db, run({ status: "stopped", stop_reason: "captcha" })),
    ).not.toThrow();
    expect(db.select().from(dry_runs).all()).toHaveLength(2);
  });

  it("rejects bad enums, unknown keys, long detail, finish before start and unsafe screenshot paths", () => {
    const bad = (over: object) =>
      expect(() => recordDryRun(db, { ...run(), ...over } as NewDryRunInput)).toThrow(ZodError);
    bad({ ats_type: "workable" });
    bad({ status: "done" });
    bad({ extra: 1 });
    bad({ stop_detail: "x".repeat(201) });
    bad({ finished_at: "2026-10-01T09:00:00.000Z" });
    bad({ started_at: "yesterday" });
    bad({ screenshot_path: "/etc/passwd" });
    bad({ screenshot_path: "dryruns/../../secret.png" });
    bad({ fields: [{ ...NAME_FIELD, source: "llm" }] });
    expect(db.select().from(dry_runs).all()).toEqual([]);
  });
});

describe("setDryRunReview / listDryRuns", () => {
  it("sets and replaces a review; wrong needs a reason, correct takes none", () => {
    const id = recordDryRun(db, run());
    const at = new Date("2026-10-02T00:00:00.000Z");
    expect(setDryRunReview(db, id, { review: "correct" }, at)).toMatchObject({
      review: "correct",
      review_reason: null,
      reviewed_at: "2026-10-02T00:00:00.000Z",
    });
    expect(() => setDryRunReview(db, id, { review: "wrong" })).toThrow(ZodError);
    expect(() => setDryRunReview(db, id, { review: "correct", reason: "other" })).toThrow(ZodError);
    expect(() => setDryRunReview(db, id, { review: "wrong", reason: "bogus" as never })).toThrow(
      ZodError,
    );
    expect(getDryRun(db, id)?.run.review).toBe("correct");
    expect(
      setDryRunReview(db, id, { review: "wrong", reason: "wrong_choice", note: "picked 2nd" }),
    ).toMatchObject({ review: "wrong", review_reason: "wrong_choice", review_note: "picked 2nd" });
  });

  it("returns null for an unknown run", () => {
    expect(setDryRunReview(db, "nope", { review: "correct" })).toBeNull();
    expect(getDryRun(db, "nope")).toBeNull();
  });

  it("lists newest first, optionally for one posting, with a limit", () => {
    const a = recordDryRun(db, run({ started_at: "2026-10-01T10:00:00.000Z" }));
    const b = recordDryRun(
      db,
      run({
        posting_id: "p2",
        started_at: "2026-10-03T10:00:00.000Z",
        finished_at: "2026-10-03T10:01:00.000Z",
      }),
    );
    const c = recordDryRun(
      db,
      run({ started_at: "2026-10-02T10:00:00.000Z", finished_at: "2026-10-02T10:01:00.000Z" }),
    );
    expect(listDryRuns(db).map((r) => r.id)).toEqual([b, c, a]);
    expect(listDryRuns(db, { postingId: "p1" }).map((r) => r.id)).toEqual([c, a]);
    expect(listDryRuns(db, { limit: 1 }).map((r) => r.id)).toEqual([b]);
    expect(() => listDryRuns(db, { limit: 0 })).toThrow(ZodError);
  });
});

describe("choice mappings", () => {
  const ref = {
    answer_key: "work.authorization",
    label: "Are you authorized to work?",
    options: ["Yes", "No", "Prefer not to say"],
  };

  it("hashes the option set regardless of order, case and punctuation", () => {
    expect(optionsHash(["Yes", "No"])).toBe(optionsHash(["no", " YES! "]));
    expect(optionsHash(["Yes", "No"])).not.toBe(optionsHash(["Yes", "No", "Maybe"]));
  });

  it("creates an unapproved mapping, finds it by any option order, and keeps one row", () => {
    expect(getChoiceMapping(db, ref)).toBeNull();
    const m = setChoiceMapping(db, { ...ref, chosen: ["Yes"] });
    expect(m).toMatchObject({
      answerKey: "work.authorization",
      normalizedLabel: "are you authorized to work",
      options: ["Yes", "No", "Prefer not to say"],
      chosen: ["Yes"],
      approved: false,
      approvedAt: null,
    });
    const shuffled = {
      ...ref,
      options: [...ref.options].reverse(),
      label: "ARE you authorized to work?",
    };
    expect(getChoiceMapping(db, shuffled)?.optionsHash).toBe(m.optionsHash);
    setChoiceMapping(db, { ...shuffled, chosen: ["Yes"] });
    expect(listChoiceMappings(db, "work.authorization")).toHaveLength(1);
  });

  it("a new option set has no mapping", () => {
    setChoiceMapping(db, { ...ref, chosen: ["Yes"] });
    expect(getChoiceMapping(db, { ...ref, options: [...ref.options, "Other"] })).toBeNull();
  });

  it("approves, keeps approval for an unchanged pick, clears it for a changed pick", () => {
    setChoiceMapping(db, { ...ref, chosen: ["Yes"] });
    const at = new Date("2026-10-02T00:00:00.000Z");
    expect(approveChoiceMapping(db, ref, true, at)).toMatchObject({
      approved: true,
      approvedAt: "2026-10-02T00:00:00.000Z",
    });
    expect(setChoiceMapping(db, { ...ref, chosen: ["Yes"] }).approved).toBe(true);
    expect(setChoiceMapping(db, { ...ref, chosen: ["No"] })).toMatchObject({
      chosen: ["No"],
      approved: false,
      approvedAt: null,
    });
    expect(approveChoiceMapping(db, ref)?.approved).toBe(true);
    expect(approveChoiceMapping(db, ref, false)).toMatchObject({
      approved: false,
      approvedAt: null,
    });
  });

  it("approve returns null for a mapping that does not exist", () => {
    expect(approveChoiceMapping(db, ref)).toBeNull();
  });

  it("supports a multi-select pick and lists by answer key only", () => {
    db.insert(answer_bank)
      .values({
        id: "a2",
        key: "work.region",
        group: "work",
        answer: "x",
        source: "dashboard",
        updated_at: T0,
      })
      .run();
    setChoiceMapping(db, { ...ref, chosen: ["Yes", "No"] });
    setChoiceMapping(db, {
      answer_key: "work.region",
      label: "Regions",
      options: ["A", "B"],
      chosen: ["A"],
    });
    setChoiceMapping(db, { ...ref, label: "Visa needed?", chosen: ["No"] });
    const list = listChoiceMappings(db, "work.authorization");
    expect(list.map((m) => m.normalizedLabel)).toEqual([
      "are you authorized to work",
      "visa needed",
    ]);
    expect(list[0]?.chosen).toEqual(["Yes", "No"]);
    expect(listChoiceMappings(db, "work.region")).toHaveLength(1);
    expect(listChoiceMappings(db, "work.none")).toEqual([]);
  });

  it("rejects a salary question, a pick outside the options and an unknown answer key", () => {
    const salary = {
      ...ref,
      label: "What is your expected salary?",
      options: ["Low", "High"],
      chosen: ["Low"],
    };
    expect(() => setChoiceMapping(db, salary)).toThrow(DryRunStoreError);
    expect(() => setChoiceMapping(db, { ...ref, chosen: ["Maybe"] })).toThrow(DryRunStoreError);
    expect(() =>
      setChoiceMapping(db, { ...ref, answer_key: "work.ghost", chosen: ["Yes"] }),
    ).toThrow(expect.objectContaining({ kind: "not_found" }));
    expect(() => setChoiceMapping(db, { ...ref, answer_key: "bad key", chosen: ["Yes"] })).toThrow(
      ZodError,
    );
    expect(() => setChoiceMapping(db, { ...ref, chosen: [] })).toThrow(ZodError);
    expect(listChoiceMappings(db, "work.authorization")).toEqual([]);
  });

  it("deleting nothing: the answer row is untouched by mapping writes", () => {
    setChoiceMapping(db, { ...ref, chosen: ["Yes"] });
    expect(
      db.select().from(answer_bank).where(eq(answer_bank.key, "work.authorization")).get()?.answer,
    ).toBe("Yes");
  });
});
