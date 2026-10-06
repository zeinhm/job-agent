import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  normalized_name: text("normalized_name").notNull().unique(),
  domain: text("domain"),
  ats_type: text("ats_type", {
    enum: ["greenhouse", "lever", "ashby"],
  }),
  ats_slug: text("ats_slug"),
  hq_country: text("hq_country"), // ISO-3166 alpha-2
  company_type: text("company_type"),
  pay_policy: text("pay_policy"),
  pay_policy_source: text("pay_policy_source"),
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
