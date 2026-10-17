import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAnswers } from "./answers.ts";

const EXAMPLE_DIR = join(import.meta.dirname, "../../../config");
let dir: string;
let lines: string[];
const out = (l: string): void => void lines.push(l);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "answers-"));
  lines = [];
});
const write = (text: string): void => writeFileSync(join(dir, "answers.yaml"), text);

describe("loadAnswers", () => {
  it("parses the committed example file", () => {
    write(readFileSync(join(EXAMPLE_DIR, "answers.example.yaml"), "utf8"));
    const entries = loadAnswers(dir, out);
    expect(entries.length).toBeGreaterThan(5);
    expect(entries.find((e) => e.key === "contact.full_name")).toMatchObject({
      group: "contact",
      answer: "Alex Example",
      approved: true,
      question: null,
      alternatives: null,
      type: null,
      choices: null,
    });
    expect(lines).toEqual([]);
  });

  it("parses the optional fields", () => {
    write(`
misc:
  how_did_you_hear:
    answer: "Job board"
    approved: false
    question: "How did you hear about this job?"
    alternatives: ["How did you find us?"]
    type: choice
    choices: ["Job board", "Referral"]
`);
    expect(loadAnswers(dir, out)).toEqual([
      {
        key: "misc.how_did_you_hear",
        group: "misc",
        answer: "Job board",
        approved: false,
        question: "How did you hear about this job?",
        alternatives: ["How did you find us?"],
        type: "choice",
        choices: ["Job board", "Referral"],
      },
    ]);
  });

  it("returns an empty bank with one line when the file is missing", () => {
    expect(loadAnswers(dir, out)).toEqual([]);
    expect(lines).toEqual(["answers.yaml not found, answer bank empty"]);
  });

  it("treats an empty file as an empty bank", () => {
    write("");
    expect(loadAnswers(dir, out)).toEqual([]);
  });

  it.each([
    [
      "unknown field",
      "g:\n  k: { answer: SECRETVALUE, approved: true, extra: 1 }\n",
      "g.k: unrecognized_keys",
    ],
    ["missing approved", "g:\n  k: { answer: SECRETVALUE }\n", "g.k.approved: invalid_type"],
    [
      "approved as string",
      "g:\n  k: { answer: SECRETVALUE, approved: 'yes' }\n",
      "g.k.approved: invalid_type",
    ],
    ["numeric answer", "g:\n  k: { answer: 7, approved: true }\n", "g.k.answer: invalid_type"],
    [
      "bad type",
      "g:\n  k: { answer: SECRETVALUE, approved: true, type: blob }\n",
      "g.k.type: invalid_value",
    ],
    [
      "choice without choices",
      "g:\n  k: { answer: SECRETVALUE, approved: true, type: choice }\n",
      "g.k.choices: custom",
    ],
    [
      "choices without choice type",
      "g:\n  k: { answer: SECRETVALUE, approved: true, type: text, choices: [a] }\n",
      "g.k.choices: custom",
    ],
    ["group is not a map", "g: SECRETVALUE\n", "g: invalid_type"],
  ])("rejects %s naming file and key path, never values", (_n, yaml, expected) => {
    write(yaml);
    let message = "";
    try {
      loadAnswers(dir, out);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("answers.yaml");
    expect(message).toContain(expected);
    expect(message).not.toContain("SECRETVALUE");
  });

  it("reports invalid YAML without content", () => {
    write("g:\n  k: [SECRETVALUE\n");
    expect(() => loadAnswers(dir, out)).toThrow(/answers\.yaml is not valid YAML/);
    try {
      loadAnswers(dir, out);
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRETVALUE");
    }
  });
});
