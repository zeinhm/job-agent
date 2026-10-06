CREATE TABLE `analysis` (
	`id` text PRIMARY KEY NOT NULL,
	`posting_id` text NOT NULL,
	`location_class` text NOT NULL CHECK (`location_class` IN ('worldwide', 'apac_ok', 'restricted', 'unclear')),
	`location_reason` text,
	`indonesia_rule` text NOT NULL CHECK (`indonesia_rule` IN ('not_applicable', 'foreign_hiring_id', 'domestic', 'unclear')),
	`indonesia_reason` text,
	`salary_idr_month_min` integer,
	`salary_idr_month_max` integer,
	`salary_status` text NOT NULL CHECK (`salary_status` IN ('listed', 'unknown', 'unparsed', 'no_fx')),
	`fx_rate_date` text,
	`decision` text NOT NULL CHECK (`decision` IN ('keep', 'reject')),
	`flags` text,
	`reasons` text,
	`analyzed_at` text NOT NULL,
	`digested_at` text,
	FOREIGN KEY (`posting_id`) REFERENCES `postings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_posting_id_unique` ON `analysis` (`posting_id`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`domain` text,
	`ats_type` text CHECK (`ats_type` IN ('greenhouse', 'lever', 'ashby')),
	`ats_slug` text,
	`hq_country` text,
	`company_type` text,
	`pay_policy` text,
	`pay_policy_source` text,
	`verified` integer DEFAULT false,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_normalized_name_unique` ON `companies` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`base` text NOT NULL,
	`quote` text NOT NULL,
	`rate` text NOT NULL,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fx_rates_date_base_quote` ON `fx_rates` (`date`,`base`,`quote`);--> statement-breakpoint
CREATE TABLE `postings` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`apply_url` text,
	`title` text NOT NULL,
	`company_id` text,
	`company_name` text NOT NULL,
	`description_text` text,
	`location_text` text,
	`remote` integer,
	`salary_text` text,
	`salary_min` integer,
	`salary_max` integer,
	`salary_currency` text,
	`salary_period` text CHECK (`salary_period` IN ('year', 'month', 'hour')),
	`posted_at` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`dedupe_hash` text,
	`canonical_posting_id` text REFERENCES `postings`(`id`) ON UPDATE no action ON DELETE no action,
	`normalized_at` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `posting_dedupe_hash` ON `postings` (`dedupe_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `posting_source_external_id` ON `postings` (`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `source_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`status` text NOT NULL CHECK (`status` IN ('ok', 'error', 'skipped')),
	`found` integer NOT NULL,
	`new` integer NOT NULL,
	`error_message` text
);
