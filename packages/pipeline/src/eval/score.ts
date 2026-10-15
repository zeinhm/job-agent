import { z } from "zod";
import { ExtractionSchema, type Extraction } from "../intel/extract.ts";

/** Fields the eval scores. A case only scores the fields its `expected` object lists. */
export const EVAL_FIELDS = [
  "listedSalary",
  "hiringScope",
  "payPolicy",
  "employment",
  "seniority",
  "companyType",
  "companyHq",
  "indonesiaExplicit",
] as const;
export type EvalField = (typeof EVAL_FIELDS)[number];

/** Listed salary bounds count as equal within this relative difference. */
export const SALARY_TOLERANCE = 0.01;

export const ExpectedSchema = ExtractionSchema.pick({
  listedSalary: true,
  hiringScope: true,
  payPolicy: true,
  employment: true,
  seniority: true,
  companyType: true,
  companyHq: true,
  indonesiaExplicit: true,
}).partial();
export type Expected = z.infer<typeof ExpectedSchema>;

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  company: z.string(),
  location: z.string().nullable(),
  salaryText: z.string().nullable(),
  description: z.string(),
  expected: ExpectedSchema.refine((e) => Object.keys(e).length > 0, "expected lists no field"),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalSetSchema = z
  .object({ version: z.literal(1), cases: z.array(EvalCaseSchema).min(1) })
  .refine((s) => new Set(s.cases.map((c) => c.id)).size === s.cases.length, "duplicate case id");
export type EvalSet = z.infer<typeof EvalSetSchema>;

function boundMatches(want: number | null, got: number | null): boolean {
  if (want === null || got === null) return want === got;
  return Math.abs(got - want) <= Math.abs(want) * SALARY_TOLERANCE;
}

function salaryMatches(
  want: NonNullable<Expected["listedSalary"]> | null,
  got: Extraction["listedSalary"],
): boolean {
  if (want === null || got === null) return want === got;
  return (
    want.currency.toUpperCase() === got.currency.toUpperCase() &&
    want.period === got.period &&
    boundMatches(want.min, got.min) &&
    boundMatches(want.max, got.max)
  );
}

/** Pass / fail per field the case expects. Exact match for enums, strings and booleans; salaries within tolerance. */
export function scoreCase(
  expected: Expected,
  actual: Extraction,
): Partial<Record<EvalField, boolean>> {
  const result: Partial<Record<EvalField, boolean>> = {};
  for (const field of EVAL_FIELDS) {
    const want = expected[field];
    if (want === undefined) continue;
    result[field] =
      field === "listedSalary"
        ? salaryMatches(expected.listedSalary ?? null, actual.listedSalary)
        : want === actual[field];
  }
  return result;
}

export interface CaseOutcome {
  id: string;
  /** Per-field result; null when the model call produced no valid output (every expected field then misses). */
  scores: Partial<Record<EvalField, boolean>> | null;
  expectedFields: readonly EvalField[];
}

export interface FieldSummary {
  field: EvalField;
  correct: number;
  total: number;
  accuracy: number;
  failingIds: string[];
}

/** Per-field accuracy over the cases that expect the field. Fields no case expects are left out. */
export function summarize(outcomes: readonly CaseOutcome[]): FieldSummary[] {
  const summaries: FieldSummary[] = [];
  for (const field of EVAL_FIELDS) {
    const relevant = outcomes.filter((o) => o.expectedFields.includes(field));
    if (relevant.length === 0) continue;
    const failingIds = relevant.filter((o) => o.scores?.[field] !== true).map((o) => o.id);
    const correct = relevant.length - failingIds.length;
    summaries.push({
      field,
      correct,
      total: relevant.length,
      accuracy: correct / relevant.length,
      failingIds,
    });
  }
  return summaries;
}
