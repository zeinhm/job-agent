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
  undo: (postingIds: string[]) =>
    apiPost("/api/reviews/undo", { posting_ids: postingIds }, BatchRecordedSchema),
};
