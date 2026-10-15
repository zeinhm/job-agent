import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  normalized_name: text("normalized_name").notNull().unique(),
  domain: text("domain"),
  ats_type: text("ats_type", {
    enum: ["greenhouse", "lever", "ashby", "smartrecruiters", "workable", "recruitee"],
  }),
  ats_slug: text("ats_slug"),
  hq_country: text("hq_country"), // ISO-3166 alpha-2
  company_type: text("company_type"),
  pay_policy: text("pay_policy", {
    enum: ["location_agnostic", "location_adjusted", "unknown"],
  }),
  pay_policy_source: text("pay_policy_source"), // free text, e.g. posting:<id>, careers:<url>
  pay_policy_checked_at: text("pay_policy_checked_at"), // ISO 8601 UTC, nullable
  ats_checked_at: text("ats_checked_at"), // ISO 8601 UTC, nullable: last apply-resolve board lookup
  discovered_via: text("discovered_via", {
    enum: ["config", "search", "manual", "apply_resolve", "yc_directory"],
  }),
  discovered_at: text("discovered_at"), // ISO 8601 UTC, nullable
  verified: integer("verified", { mode: "boolean" }).default(false),
  created_at: text("created_at").notNull(), // ISO 8601 UTC
});

export const postings = sqliteTable(
  "postings",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    external_id: text("external_id").notNull(),
    url: text("url").notNull(),
    apply_url: text("apply_url"),
    title: text("title").notNull(),
    company_id: text("company_id").references(() => companies.id),
    company_name: text("company_name").notNull(),
    description_text: text("description_text"),
    location_text: text("location_text"),
    remote: integer("remote", { mode: "boolean" }),
    salary_text: text("salary_text"),
    salary_min: integer("salary_min"),
    salary_max: integer("salary_max"),
    salary_currency: text("salary_currency"),
    salary_period: text("salary_period", { enum: ["year", "month", "hour"] }),
    posted_at: text("posted_at"), // ISO 8601 UTC, nullable
    first_seen_at: text("first_seen_at").notNull(), // ISO 8601 UTC
    last_seen_at: text("last_seen_at").notNull(), // ISO 8601 UTC
    dedupe_hash: text("dedupe_hash"),
    canonical_posting_id: text("canonical_posting_id"), // Self-reference, no FK constraint here
    normalized_at: text("normalized_at"), // ISO 8601 UTC, nullable
    content_hash: text("content_hash"),
    updated_at: text("updated_at"), // ISO 8601 UTC, nullable
  },
  (table) => ({
    posting_source_external_id: unique("posting_source_external_id").on(
      table.source,
      table.external_id,
    ),
    posting_dedupe_hash: index("posting_dedupe_hash").on(table.dedupe_hash),
  }),
);

export const analysis = sqliteTable("analysis", {
  id: text("id").primaryKey(),
  posting_id: text("posting_id")
    .notNull()
    .unique()
    .references(() => postings.id),
  location_class: text("location_class", {
    enum: ["worldwide", "apac_ok", "restricted", "unclear"],
  }).notNull(),
  location_reason: text("location_reason"),
  indonesia_rule: text("indonesia_rule", {
    enum: ["not_applicable", "foreign_hiring_id", "domestic", "unclear"],
  }).notNull(),
  indonesia_reason: text("indonesia_reason"),
  salary_idr_month_min: integer("salary_idr_month_min"),
  salary_idr_month_max: integer("salary_idr_month_max"),
  salary_status: text("salary_status", {
    enum: ["listed", "unknown", "unparsed", "no_fx"],
  }).notNull(),
  fx_rate_date: text("fx_rate_date"), // YYYY-MM-DD, nullable
  decision: text("decision", { enum: ["keep", "reject"] }).notNull(),
  flags: text("flags"), // JSON text array
  reasons: text("reasons"), // JSON text array
  analyzed_at: text("analyzed_at").notNull(), // ISO 8601 UTC
  digested_at: text("digested_at"), // YYYY-MM-DD, nullable
});

export const source_runs = sqliteTable("source_runs", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  started_at: text("started_at").notNull(), // ISO 8601 UTC
  finished_at: text("finished_at").notNull(), // ISO 8601 UTC
  status: text("status", { enum: ["ok", "error", "skipped"] }).notNull(),
  found: integer("found").notNull(),
  new: integer("new").notNull(),
  error_message: text("error_message"), // nullable
  saturated: integer("saturated"), // searches whose first page was full (JobSpy sources); null for others
});

export const fx_rates = sqliteTable(
  "fx_rates",
  {
    id: text("id").primaryKey(),
    date: text("date").notNull(), // YYYY-MM-DD
    base: text("base").notNull(), // always "USD"
    quote: text("quote").notNull(),
    rate: text("rate").notNull(), // "1 USD = rate QUOTE"
    source: text("source").notNull(),
    fetched_at: text("fetched_at").notNull(), // ISO 8601 UTC
  },
  (table) => ({
    fx_rates_date_base_quote: unique("fx_rates_date_base_quote").on(
      table.date,
      table.base,
      table.quote,
    ),
  }),
);

export const llm_calls = sqliteTable("llm_calls", {
  id: text("id").primaryKey(),
  day: text("day").notNull(), // YYYY-MM-DD, Asia/Jakarta
  model: text("model").notNull(),
  purpose: text("purpose", {
    enum: ["extract", "company_research", "fit", "apply_link", "eval_extract", "eval_fit"],
  }).notNull(),
  posting_id: text("posting_id").references(() => postings.id),
  company_id: text("company_id").references(() => companies.id),
  input_tokens: integer("input_tokens").notNull(),
  output_tokens: integer("output_tokens").notNull(),
  cache_read_tokens: integer("cache_read_tokens").notNull(),
  cost_usd: text("cost_usd").notNull(), // text decimal
  status: text("status", { enum: ["ok", "error"] }).notNull(),
  created_at: text("created_at").notNull(), // ISO 8601 UTC
});

export const intel = sqliteTable("intel", {
  id: text("id").primaryKey(),
  posting_id: text("posting_id")
    .notNull()
    .unique()
    .references(() => postings.id),
  status: text("status", {
    enum: ["pending", "done", "budget_wait", "failed", "fx_wait"],
  }).notNull(),
  extraction: text("extraction"), // JSON text, Zod-validated
  extract_model: text("extract_model"),
  extract_prompt_version: text("extract_prompt_version"),
  final_decision: text("final_decision", { enum: ["keep", "reject", "suspicious"] }),
  resolved_reasons: text("resolved_reasons"), // JSON text array
  scam_score: integer("scam_score"), // 0-100
  scam_reasons: text("scam_reasons"), // JSON text array
  fit_score: integer("fit_score"), // 0-100, nullable
  fit_reasons: text("fit_reasons"), // JSON text array
  fit_model: text("fit_model"),
  fit_prompt_version: text("fit_prompt_version"),
  tier: text("tier", { enum: ["indonesia", "regional", "global_adjusted", "global_flat"] }),
  ask_idr_month: integer("ask_idr_month"),
  ask_usd_year: integer("ask_usd_year"),
  ask_text: text("ask_text"),
  ask_reason: text("ask_reason"),
  updated_at: text("updated_at").notNull(), // ISO 8601 UTC
});

export const APPLY_TYPES = [
  "ats",
  "company_form",
  "paid_aggregator",
  "signup_required",
  "unknown",
] as const;
export const APPLY_METHODS = [
  "ats_db",
  "ats_board",
  "careers_page",
  "posting_text",
  "llm",
  "source",
  "owner",
] as const;

export const apply_links = sqliteTable("apply_links", {
  id: text("id").primaryKey(),
  posting_id: text("posting_id")
    .notNull()
    .unique()
    .references(() => postings.id),
  apply_url: text("apply_url").notNull(),
  apply_type: text("apply_type", { enum: APPLY_TYPES }).notNull(),
  method: text("method", { enum: APPLY_METHODS }).notNull(),
  ats_type: text("ats_type"),
  ats_slug: text("ats_slug"),
  found_on: text("found_on").notNull(), // source name of the discovery listing
  reason: text("reason"),
  checked_at: text("checked_at").notNull(), // ISO 8601 UTC
});

export const REVIEW_STATUS_ACTIONS = [
  "interested",
  "applied_manually",
  "not_interested",
  "later",
] as const;
export const REVIEW_ACTIONS = [
  ...REVIEW_STATUS_ACTIONS,
  "wrong_apply_link",
  "pay_policy",
  "scam",
  "not_scam",
  "ask_ok",
  "ask_too_high",
  "ask_too_low",
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
export const ANSWER_TYPES = ["text", "long_text", "yes_no", "number", "choice"] as const;
export const ANSWER_SOURCES = ["config", "dashboard"] as const;
export const UNKNOWN_QUESTION_STATUSES = ["open", "answered", "linked", "dismissed"] as const;

// Append-only review history; the newest status-action row per posting is its current state.
export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    posting_id: text("posting_id")
      .notNull()
      .references(() => postings.id), // canonical posting
    action: text("action", { enum: REVIEW_ACTIONS }).notNull(),
    reason: text("reason", { enum: NOT_INTERESTED_REASONS }), // not_interested only
    note: text("note"),
    apply_url: text("apply_url"), // wrong_apply_link: optional corrected URL
    pay_policy: text("pay_policy", { enum: ["location_agnostic", "location_adjusted"] }),
    reviewed_at: text("reviewed_at").notNull(), // ISO 8601 UTC
    review_day: text("review_day").notNull(), // YYYY-MM-DD, Asia/Jakarta
    // Snapshot of what the tool said at review time (PLAN 5.5)
    fit_score: integer("fit_score"),
    final_decision: text("final_decision", { enum: ["keep", "reject", "suspicious"] }),
    tier: text("tier", { enum: ["indonesia", "regional", "global_adjusted", "global_flat"] }),
    apply_type: text("apply_type", { enum: APPLY_TYPES }),
    extract_prompt_version: text("extract_prompt_version"),
    fit_prompt_version: text("fit_prompt_version"),
  },
  (table) => ({
    reviews_posting: index("reviews_posting").on(table.posting_id, table.reviewed_at),
    reviews_day: index("reviews_day").on(table.review_day),
  }),
);

export const answer_bank = sqliteTable("answer_bank", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(), // group.key
  group: text("group").notNull(),
  question: text("question"),
  answer: text("answer").notNull(),
  type: text("type", { enum: ANSWER_TYPES }),
  choices: text("choices"), // JSON text array
  alternatives: text("alternatives"), // JSON text array of other phrasings
  approved: integer("approved", { mode: "boolean" }).notNull().default(false),
  approved_at: text("approved_at"), // ISO 8601 UTC, nullable
  source: text("source", { enum: ANSWER_SOURCES }).notNull(),
  updated_at: text("updated_at").notNull(), // ISO 8601 UTC
});

export const posting_questions = sqliteTable(
  "posting_questions",
  {
    id: text("id").primaryKey(),
    posting_id: text("posting_id")
      .notNull()
      .references(() => postings.id),
    ats_type: text("ats_type").notNull(),
    question_id: text("question_id").notNull(), // the ATS's own id
    label: text("label").notNull(),
    required: integer("required", { mode: "boolean" }).notNull(),
    type: text("type").notNull(),
    options: text("options"), // JSON text
    normalized_label: text("normalized_label").notNull(),
    matched_key: text("matched_key"), // answer_bank.key, nullable
    fetched_at: text("fetched_at").notNull(), // ISO 8601 UTC
  },
  (table) => ({
    posting_questions_posting_question: unique("posting_questions_posting_question").on(
      table.posting_id,
      table.question_id,
    ),
    posting_questions_label: index("posting_questions_label").on(table.normalized_label),
  }),
);

export const unknown_questions = sqliteTable("unknown_questions", {
  id: text("id").primaryKey(),
  normalized_label: text("normalized_label").notNull().unique(),
  label: text("label").notNull(), // first seen wording
  posting_count: integer("posting_count").notNull(),
  first_seen_at: text("first_seen_at").notNull(), // ISO 8601 UTC
  last_seen_at: text("last_seen_at").notNull(), // ISO 8601 UTC
  status: text("status", { enum: UNKNOWN_QUESTION_STATUSES }).notNull().default("open"),
  answer_key: text("answer_key"), // answer_bank.key, nullable
});

// Inferred types for inserts and selects
export type Company = InferSelectModel<typeof companies>;
export type NewCompany = InferInsertModel<typeof companies>;

export type Posting = InferSelectModel<typeof postings>;
export type NewPosting = InferInsertModel<typeof postings>;

export type Analysis = InferSelectModel<typeof analysis>;
export type NewAnalysis = InferInsertModel<typeof analysis>;

export type SourceRun = InferSelectModel<typeof source_runs>;
export type NewSourceRun = InferInsertModel<typeof source_runs>;

export type FxRate = InferSelectModel<typeof fx_rates>;
export type NewFxRate = InferInsertModel<typeof fx_rates>;

export type LlmCall = InferSelectModel<typeof llm_calls>;
export type NewLlmCall = InferInsertModel<typeof llm_calls>;

export type Intel = InferSelectModel<typeof intel>;
export type NewIntel = InferInsertModel<typeof intel>;

export type ApplyLink = InferSelectModel<typeof apply_links>;
export type NewApplyLink = InferInsertModel<typeof apply_links>;

export type Review = InferSelectModel<typeof reviews>;
export type NewReview = InferInsertModel<typeof reviews>;

export type AnswerBankRow = InferSelectModel<typeof answer_bank>;
export type NewAnswerBankRow = InferInsertModel<typeof answer_bank>;

export type PostingQuestion = InferSelectModel<typeof posting_questions>;
export type NewPostingQuestion = InferInsertModel<typeof posting_questions>;

export type UnknownQuestion = InferSelectModel<typeof unknown_questions>;
export type NewUnknownQuestion = InferInsertModel<typeof unknown_questions>;
