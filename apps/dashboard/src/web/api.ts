import { z } from "zod";

export const HealthSchema = z.object({ ok: z.boolean(), db: z.enum(["ok", "error"]) });
export type Health = z.infer<typeof HealthSchema>;

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`api ${path} ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

// Same-origin JSON GET, validated with a Zod schema. Never echoes response bodies into errors.
export async function apiGet<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  const res = await fetch(new URL(path, window.location.origin), {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) throw new ApiError(res.status, path);
  return schema.parse(await res.json());
}

// Same-origin JSON POST. The browser adds the Origin header the server's mutation guard checks.
export async function apiPost<S extends z.ZodType>(
  path: string,
  body: unknown,
  schema: S,
): Promise<z.infer<S>> {
  const res = await fetch(new URL(path, window.location.origin), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, path);
  return schema.parse(await res.json());
}

// Same-origin JSON PATCH, same rules as apiPost.
export async function apiPatch<S extends z.ZodType>(
  path: string,
  body: unknown,
  schema: S,
): Promise<z.infer<S>> {
  const res = await fetch(new URL(path, window.location.origin), {
    method: "PATCH",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, path);
  return schema.parse(await res.json());
}

export const ANSWER_TYPES = ["text", "long_text", "yes_no", "number", "choice"] as const;

export const AnswerSchema = z.object({
  key: z.string(),
  group: z.string(),
  question: z.string().nullable(),
  answer: z.string(),
  type: z.enum(ANSWER_TYPES).nullable(),
  choices: z.array(z.string()).nullable(),
  alternatives: z.array(z.string()).nullable(),
  approved: z.boolean(),
  approvedAt: z.string().nullable(),
  source: z.enum(["config", "dashboard"]),
  updatedAt: z.string(),
});
export type Answer = z.infer<typeof AnswerSchema>;

const AnswersSchema = z.object({ answers: z.array(AnswerSchema) });
const ExportedSchema = z.object({ path: z.string(), count: z.number() });

/** Body of PATCH /api/answers/:key (mirrors the server's AnswerPatchSchema). */
export interface AnswerPatchBody {
  answer?: string;
  question?: string | null;
  alternatives?: string[] | null;
  approved?: boolean;
}

/** Body of POST /api/answers. */
export interface NewAnswerBody {
  group: string;
  key: string;
  answer: string;
  question?: string;
}

export const InboxItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  postingCount: z.number(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  salary: z.boolean(),
  examples: z.array(z.object({ postingId: z.string(), title: z.string(), company: z.string() })),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const MappingNeedSchema = z.object({
  answerKey: z.string(),
  label: z.string(),
  normalizedLabel: z.string(),
  options: z.array(z.string()),
  multi: z.boolean(),
  answerText: z.string(),
  postingCount: z.number(),
  examples: z.array(z.object({ postingId: z.string(), title: z.string(), company: z.string() })),
  picked: z.array(z.string()).nullable(),
});
export type MappingNeed = z.infer<typeof MappingNeedSchema>;

export const ChoiceMappingSchema = z.object({
  answerKey: z.string(),
  normalizedLabel: z.string(),
  optionsHash: z.string(),
  options: z.array(z.string()),
  chosen: z.array(z.string()),
  approved: z.boolean(),
  approvedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type ChoiceMapping = z.infer<typeof ChoiceMappingSchema>;
const ChoiceMappingsSchema = z.object({ mappings: z.array(ChoiceMappingSchema) });

/** Body of POST /api/choice-mappings and POST /api/choice-mappings/remove (the latter without `chosen`). */
export interface ChoiceMappingBody {
  answer_key: string;
  label: string;
  options: string[];
  chosen: string[];
}

const InboxSchema = z.object({
  openCount: z.number(),
  items: z.array(InboxItemSchema),
  mappings: z.array(MappingNeedSchema),
});
export type Inbox = z.infer<typeof InboxSchema>;
const InboxResultSchema = z.object({ openCount: z.number(), key: z.string().nullable() });

/** Body of POST /api/inbox/:id/answer. */
export interface InboxAnswerBody {
  group: string;
  key: string;
  answer: string;
  type: (typeof ANSWER_TYPES)[number];
  choices?: string[];
  approved?: boolean;
}

export const REVIEW_STATUSES = [
  "open",
  "interested",
  "applied_manually",
  "not_interested",
  "later",
] as const;

export const NOT_INTERESTED_REASONS = [
  "location",
  "timezone",
  "role",
  "seniority",
  "stack",
  "salary",
  "company",
  "domestic_company",
  "language",
  "duplicate",
  "expired",
  "scam_suspected",
  "other",
] as const;
export type NotInterestedReason = (typeof NOT_INTERESTED_REASONS)[number];

export const PAY_POLICIES = ["location_agnostic", "location_adjusted"] as const;
export type PayPolicy = (typeof PAY_POLICIES)[number];

export const SIMPLE_ACTIONS = [
  "interested",
  "applied_manually",
  "later",
  "scam",
  "not_scam",
] as const;
export const ASK_ACTIONS = ["ask_ok", "ask_too_high", "ask_too_low"] as const;

const ReviewStateSchema = z.object({
  status: z.enum(REVIEW_STATUSES),
  reason: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  processed: z.boolean(),
});
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const QueueItemSchema = z.object({
  postingId: z.string(),
  kind: z.string(),
  title: z.string(),
  company: z.string(),
  locations: z.array(z.string()),
  locationClass: z.string(),
  fitScore: z.number().nullable(),
  fitReasons: z.array(z.string()),
  flags: z.array(z.string()),
  tier: z.string().nullable(),
  ask: z.string().nullable(),
  askText: z.string().nullable(),
  listedSalary: z.string(),
  scamScore: z.number().nullable(),
  scamReason: z.string().nullable(),
  applyUrl: z.string(),
  applyType: z.string(),
  review: ReviewStateSchema,
  questions: z.object({
    total: z.number(),
    covered: z.number(),
    needsMapping: z.number(),
    unknown: z.number(),
    salary: z.number(),
  }),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const QueueSchema = z.object({
  date: z.string(),
  sections: z.object({
    top: z.array(QueueItemSchema),
    needs_a_look: z.array(QueueItemSchema),
    suspicious: z.array(QueueItemSchema),
    waiting: z.array(QueueItemSchema),
  }),
  firstReviewAt: z.string().nullable(),
});
export type Queue = z.infer<typeof QueueSchema>;

const ReviewRowSchema = z.object({
  id: z.string(),
  action: z.string(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  apply_url: z.string().nullable(),
  pay_policy: z.string().nullable(),
  reviewed_at: z.string(),
});

export const PostingDetailSchema = QueueItemSchema.extend({
  descriptionText: z.string().nullable(),
  reasons: z.object({
    fit: z.array(z.string()),
    scam: z.array(z.string()),
    resolved: z.array(z.string()),
    rules: z.array(z.string()),
  }),
  history: z.array(ReviewRowSchema),
});
export type PostingDetail = z.infer<typeof PostingDetailSchema>;

/** Body of POST /api/reviews (mirrors the server's ReviewInputSchema). */
export interface ReviewBody {
  posting_id: string;
  action:
    | (typeof SIMPLE_ACTIONS)[number]
    | (typeof ASK_ACTIONS)[number]
    | "not_interested"
    | "wrong_apply_link"
    | "pay_policy";
  reason?: NotInterestedReason;
  note?: string;
  apply_url?: string;
  pay_policy?: PayPolicy;
}

export const DRY_RUN_REVIEW_REASONS = [
  "wrong_value",
  "wrong_choice",
  "missing_field",
  "salary_wrong",
  "stopped_wrongly",
  "should_have_stopped",
  "page_broken",
  "other",
] as const;

const ReviewVerdictSchema = z.enum(["correct", "wrong"]);

export const DryRunDoneWhenSchema = z.object({
  correct: z.number(),
  reviewed: z.number(),
  fullFills: z.number(),
  met: z.boolean(),
  line: z.string(),
});
export type DryRunDoneWhen = z.infer<typeof DryRunDoneWhenSchema>;

export const DryRunRowSchema = z.object({
  id: z.string(),
  postingId: z.string(),
  title: z.string(),
  company: z.string(),
  atsType: z.string(),
  status: z.string(),
  stopReason: z.string().nullable(),
  fieldsFilled: z.number(),
  fieldsTotal: z.number(),
  startedAt: z.string(),
  fixture: z.boolean(),
  review: ReviewVerdictSchema.nullable(),
  reviewReason: z.string().nullable(),
});
export type DryRunRow = z.infer<typeof DryRunRowSchema>;

const DryRunListSchema = z.object({
  runs: z.array(DryRunRowSchema),
  doneWhen: DryRunDoneWhenSchema,
});

export const DryRunDetailSchema = DryRunRowSchema.extend({
  finishedAt: z.string(),
  stopDetail: z.string().nullable(),
  reviewNote: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  hasScreenshot: z.boolean(),
  blockedRequestsRecorded: z.number(),
  fields: z.array(
    z.object({
      label: z.string(),
      fieldType: z.string(),
      required: z.boolean(),
      source: z.string(),
      answerKey: z.string().nullable(),
      value: z.string().nullable(),
      filled: z.boolean(),
      note: z.string().nullable(),
    }),
  ),
});
export type DryRunDetail = z.infer<typeof DryRunDetailSchema>;

/** Body of POST /api/dry-runs/:id/review. */
export interface DryRunReviewBody {
  review: "correct" | "wrong";
  reason?: (typeof DRY_RUN_REVIEW_REASONS)[number];
  note?: string;
  missing_label?: string;
}

const DryRunReviewedSchema = z.object({
  review: ReviewVerdictSchema.nullable(),
  reason: z.string().nullable(),
  inboxOpen: z.boolean(),
  doneWhen: DryRunDoneWhenSchema,
});

const AskCheckSchema = z.object({
  ok: z.number(),
  too_high: z.number(),
  too_low: z.number(),
  total: z.number(),
  enough: z.boolean(),
});

export const StatsSchema = z.object({
  date: z.string(),
  matches: z.number(),
  processed: z.number(),
  open: z.number(),
  firstReviewAt: z.string().nullable(),
  lastReviewAt: z.string().nullable(),
  elapsedMinutes: z.number(),
  medianSecondsPerPosting: z.number().nullable(),
  actions: z.record(z.string(), z.number()),
  reasons: z.record(z.string(), z.number()),
  askChecks: z.object({
    indonesia: AskCheckSchema,
    regional: AskCheckSchema,
    global_adjusted: AskCheckSchema,
    global_flat: AskCheckSchema,
    target: z.number(),
  }),
  doneWhenMet: z.boolean(),
  dryRuns: DryRunDoneWhenSchema,
  week: z.array(
    z.object({
      date: z.string(),
      matches: z.number(),
      processed: z.number(),
      open: z.number(),
      elapsedMinutes: z.number(),
      doneWhenMet: z.boolean(),
    }),
  ),
});
export type Stats = z.infer<typeof StatsSchema>;

const RecordedSchema = z.object({ state: ReviewStateSchema });
const BatchRecordedSchema = z.object({ recorded: z.array(z.object({ state: ReviewStateSchema })) });

export const STATUS_ACTIONS = [
  "interested",
  "applied_manually",
  "not_interested",
  "later",
] as const;

/** Body of POST /api/reviews/bulk (mirrors the server's BulkReviewInputSchema). */
export interface BulkBody {
  posting_ids: string[];
  action: (typeof STATUS_ACTIONS)[number];
  reason?: NotInterestedReason;
  note?: string;
}

export const api = {
  health: (): Promise<Health> => apiGet("/api/health", HealthSchema),
  queue: (day: string): Promise<Queue> =>
    apiGet(`/api/queue?date=${encodeURIComponent(day)}`, QueueSchema),
  stats: (day: string): Promise<Stats> =>
    apiGet(`/api/stats?date=${encodeURIComponent(day)}`, StatsSchema),
  posting: (id: string): Promise<PostingDetail> =>
    apiGet(`/api/postings/${encodeURIComponent(id)}`, PostingDetailSchema),
  review: (body: ReviewBody) => apiPost("/api/reviews", body, RecordedSchema),
  bulk: (body: BulkBody) => apiPost("/api/reviews/bulk", body, BatchRecordedSchema),
  answers: (): Promise<Answer[]> => apiGet("/api/answers", AnswersSchema).then((r) => r.answers),
  patchAnswer: (key: string, body: AnswerPatchBody) =>
    apiPatch(`/api/answers/${encodeURIComponent(key)}`, body, AnswerSchema),
  createAnswer: (body: NewAnswerBody) => apiPost("/api/answers", body, AnswerSchema),
  exportAnswers: () => apiPost("/api/answers/export", {}, ExportedSchema),
  inbox: (): Promise<Inbox> => apiGet("/api/inbox", InboxSchema),
  answerInbox: (id: string, body: InboxAnswerBody) =>
    apiPost(`/api/inbox/${encodeURIComponent(id)}/answer`, body, InboxResultSchema),
  linkInbox: (id: string, key: string) =>
    apiPost(`/api/inbox/${encodeURIComponent(id)}/link`, { key }, InboxResultSchema),
  dismissInbox: (id: string) =>
    apiPost(`/api/inbox/${encodeURIComponent(id)}/dismiss`, {}, InboxResultSchema),
  choiceMappings: (): Promise<ChoiceMapping[]> =>
    apiGet("/api/choice-mappings", ChoiceMappingsSchema).then((r) => r.mappings),
  saveChoiceMapping: (body: ChoiceMappingBody) =>
    apiPost("/api/choice-mappings", body, ChoiceMappingSchema),
  removeChoiceMapping: (body: Omit<ChoiceMappingBody, "chosen">) =>
    apiPost("/api/choice-mappings/remove", body, z.object({ removed: z.boolean() })),
  dryRuns: () => apiGet("/api/dry-runs", DryRunListSchema),
  dryRun: (id: string): Promise<DryRunDetail> =>
    apiGet(`/api/dry-runs/${encodeURIComponent(id)}`, DryRunDetailSchema),
  dryRunScreenshotUrl: (id: string): string => `/api/dry-runs/${encodeURIComponent(id)}/screenshot`,
  reviewDryRun: (id: string, body: DryRunReviewBody) =>
    apiPost(`/api/dry-runs/${encodeURIComponent(id)}/review`, body, DryRunReviewedSchema),
  undo: (postingIds: string[]) =>
    apiPost("/api/reviews/undo", { posting_ids: postingIds }, BatchRecordedSchema),
};
