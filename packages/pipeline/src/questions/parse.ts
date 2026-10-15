import { z } from "zod";
import { plainText } from "./normalize.ts";

/** Field kinds stored in `posting_questions.type`. `yes_no`, `choice`, `text`, `long_text` line up with the answer-bank types. */
export const QUESTION_TYPES = [
  "text",
  "long_text",
  "yes_no",
  "choice",
  "multi_choice",
  "file",
  "other",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export interface FetchedQuestion {
  /** The ATS's own id (Greenhouse field name, Workable field id, Recruitee question id). */
  question_id: string;
  label: string;
  required: boolean;
  type: QuestionType;
  /** Option labels of a choice question; null for every other type. */
  options: string[] | null;
}

/** A response that does not have the documented shape; the caller prints it as an error line for the posting. */
export class ParseError extends Error {}

const str = z.string();

function parseWith<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join(".") || "(root)";
    throw new ParseError(`${what} response does not match the expected shape at ${where}`);
  }
  return parsed.data;
}

const isYesNo = (options: string[]): boolean => {
  const set = new Set(options.map((o) => o.trim().toLowerCase()));
  return options.length === 2 && set.has("yes") && set.has("no");
};

function choiceType(options: string[], multi: boolean): QuestionType {
  if (multi) return "multi_choice";
  return isYesNo(options) ? "yes_no" : "choice";
}

/** Rejects a response that lists one question id twice (the table keys on posting + question id). */
function unique(questions: FetchedQuestion[], what: string): FetchedQuestion[] {
  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.question_id)) throw new ParseError(`${what} response repeats a question id`);
    seen.add(q.question_id);
  }
  return questions;
}

const labelOf = (raw: string | null | undefined, fallback: string): string => {
  const text = plainText(raw ?? "");
  return text === "" ? fallback : text;
};

// ---- Greenhouse: GET /v1/boards/{board}/jobs/{id}?questions=true ----

const ghValue = z.object({ label: str });
const ghField = z.object({
  name: str.min(1),
  type: str,
  values: z.array(ghValue).nullish(),
});
const ghQuestion = z.object({
  label: str,
  required: z.boolean(),
  fields: z.array(ghField).min(1),
});
const ghJob = z.object({
  questions: z.array(ghQuestion),
  location_questions: z.array(ghQuestion).nullish(),
  // EEOC / demographic blocks are voluntary and never answered by the tool: checked for shape, not stored.
  compliance: z.array(z.object({ questions: z.array(ghQuestion).nullish() })).nullish(),
});

const GH_TYPES: Record<string, QuestionType> = {
  input_text: "text",
  textarea: "long_text",
  input_file: "file",
  multi_value_single_select: "choice",
  multi_value_multi_select: "multi_choice",
};

export function parseGreenhouse(body: unknown): FetchedQuestion[] {
  const job = parseWith(ghJob, body, "greenhouse");
  const out: FetchedQuestion[] = [];
  for (const q of [...job.questions, ...(job.location_questions ?? [])]) {
    const field = q.fields[0];
    if (field === undefined || field.type === "input_hidden") continue;
    const options = (field.values ?? []).map((v) => plainText(v.label));
    const base = GH_TYPES[field.type] ?? "other";
    const isSelect = base === "choice" || base === "multi_choice";
    out.push({
      question_id: field.name,
      label: labelOf(q.label, field.name),
      required: q.required,
      type: isSelect ? choiceType(options, base === "multi_choice") : base,
      options: isSelect ? options : null,
    });
  }
  return unique(out, "greenhouse");
}

// ---- Workable: GET https://apply.workable.com/api/v1/jobs/{shortcode}/form ----

const wkField = z.object({
  id: str.min(1),
  label: str.nullish(),
  required: z.boolean(),
  type: str,
  options: z.array(z.object({ value: str })).nullish(),
  singleOption: z.boolean().nullish(),
});
const wkForm = z.array(z.object({ name: str.nullish(), fields: z.array(wkField) }));

const WK_TYPES: Record<string, QuestionType> = {
  text: "text",
  email: "text",
  phone: "text",
  number: "text",
  paragraph: "long_text",
  boolean: "yes_no",
  file: "file",
};

export function parseWorkable(body: unknown): FetchedQuestion[] {
  const sections = parseWith(wkForm, body, "workable");
  const out: FetchedQuestion[] = [];
  for (const section of sections) {
    for (const f of section.fields) {
      const isSelect = f.type === "dropdown" || f.type === "multiple";
      const options = (f.options ?? []).map((o) => plainText(o.value));
      const multi = f.type === "multiple" || (isSelect && f.singleOption === false);
      out.push({
        question_id: f.id,
        label: labelOf(f.label, f.id),
        required: f.required,
        type: isSelect ? choiceType(options, multi) : (WK_TYPES[f.type] ?? "other"),
        options: isSelect ? options : null,
      });
    }
  }
  return unique(out, "workable");
}

// ---- Recruitee: GET https://{slug}.recruitee.com/api/offers/ (open_questions inside each offer) ----

const rcQuestion = z.object({
  id: z.union([z.number(), str]),
  required: z.boolean(),
  kind: str,
  body: str,
  open_question_options: z.array(z.object({ body: str })).nullish(),
});
const rcOffer = z.object({
  id: z.number(),
  slug: str.nullish(),
  options_cv: str.nullish(),
  options_cover_letter: str.nullish(),
  options_phone: str.nullish(),
  open_questions: z.array(rcQuestion).nullish(),
});
const rcOffers = z.object({ offers: z.array(rcOffer) });

export type RecruiteeOffer = z.infer<typeof rcOffer>;

export function parseRecruiteeOffers(body: unknown): RecruiteeOffer[] {
  return parseWith(rcOffers, body, "recruitee").offers;
}

const RC_TYPES: Record<string, QuestionType> = {
  string: "text",
  text: "long_text",
  boolean: "yes_no",
  single_choice: "choice",
  multi_choice: "multi_choice",
};

/** `options_*` switches of an offer: `off`, `optional` or `required`. */
const RC_STANDARD: Array<{
  key: "options_cv" | "options_cover_letter" | "options_phone";
  label: string;
  type: QuestionType;
}> = [
  { key: "options_cv", label: "Resume/CV", type: "file" },
  { key: "options_cover_letter", label: "Cover letter", type: "file" },
  { key: "options_phone", label: "Phone", type: "text" },
];

export function recruiteeQuestions(offer: RecruiteeOffer): FetchedQuestion[] {
  const out: FetchedQuestion[] = [];
  for (const s of RC_STANDARD) {
    const mode = offer[s.key];
    if (mode === undefined || mode === null || mode === "off") continue;
    out.push({
      question_id: s.key,
      label: s.label,
      required: mode === "required",
      type: s.type,
      options: null,
    });
  }
  for (const q of offer.open_questions ?? []) {
    if (q.kind === "infobox") continue; // informational text, not a question
    const options = (q.open_question_options ?? []).map((o) => plainText(o.body));
    const base = RC_TYPES[q.kind] ?? "other";
    const isSelect = base === "choice" || base === "multi_choice";
    out.push({
      question_id: String(q.id),
      label: labelOf(q.body, String(q.id)),
      required: q.required,
      type: isSelect ? choiceType(options, base === "multi_choice") : base,
      options: isSelect ? options : null,
    });
  }
  return unique(out, "recruitee");
}
