import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ANSWER_TYPES } from "@job-agent/core";
import { parse } from "yaml";
import { z } from "zod";

const FILE = "answers.yaml";

const entrySchema = z
  .strictObject({
    answer: z.string().min(1),
    approved: z.boolean(),
    question: z.string().min(1).optional(),
    alternatives: z.array(z.string().min(1)).optional(),
    type: z.enum(ANSWER_TYPES).optional(),
    choices: z.array(z.string().min(1)).min(1).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.type === "choice" && entry.choices === undefined)
      ctx.addIssue({ code: "custom", path: ["choices"], message: "choices required" });
    if (entry.type !== "choice" && entry.choices !== undefined)
      ctx.addIssue({ code: "custom", path: ["choices"], message: "choices only for choice" });
  });

// Keys become `group.key` in the DB, so a dot in a name would make the key ambiguous.
const name = z.string().regex(/^[A-Za-z0-9_-]+$/);
const answersSchema = z.record(name, z.record(name, entrySchema));

export interface AnswerEntry {
  /** `group.key`, unique in the answer bank. */
  key: string;
  group: string;
  answer: string;
  approved: boolean;
  question: string | null;
  alternatives: string[] | null;
  type: (typeof ANSWER_TYPES)[number] | null;
  choices: string[] | null;
}

/**
 * Reads `<dir>/answers.yaml`. A missing file returns an empty bank (and says so once through `out`); any other
 * read error or an invalid file throws. Errors name the file and key path, never values.
 */
export function loadAnswers(
  dir: string,
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): AnswerEntry[] {
  let text: string;
  try {
    text = readFileSync(join(dir, FILE), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    if (code === "ENOENT") {
      out(`${FILE} not found, answer bank empty`);
      return [];
    }
    throw new Error(`Config file ${FILE} could not be read in ${dir} (${code})`, { cause: err });
  }

  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "YAML_ERROR";
    throw new Error(`Config file ${FILE} is not valid YAML (${code})`);
  }

  const result = answersSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.code}`)
      .join("; ");
    throw new Error(`Config file ${FILE} is invalid: ${issues}`);
  }

  return Object.entries(result.data).flatMap(([group, entries]) =>
    Object.entries(entries).map(([key, e]) => ({
      key: `${group}.${key}`,
      group,
      answer: e.answer,
      approved: e.approved,
      question: e.question ?? null,
      alternatives: e.alternatives ?? null,
      type: e.type ?? null,
      choices: e.choices ?? null,
    })),
  );
}
