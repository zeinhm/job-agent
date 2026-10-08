-- companies is rebuilt: the Phase 1 CHECK on ats_type does not allow the new ATS values and
-- SQLite cannot alter a CHECK in place. defer_foreign_keys lets postings/llm_calls keep pointing at it.
PRAGMA defer_foreign_keys = ON;--> statement-breakpoint
CREATE TABLE `__old_companies` AS SELECT * FROM `companies`;--> statement-breakpoint
DROP TABLE `companies`;--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`domain` text,
	`ats_type` text CHECK (`ats_type` IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee')),
	`ats_slug` text,
	`hq_country` text,
	`company_type` text,
	`pay_policy` text,
	`pay_policy_source` text,
	`pay_policy_checked_at` text,
	`discovered_via` text,
	`discovered_at` text,
	`verified` integer DEFAULT false,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `companies` (`id`, `name`, `normalized_name`, `domain`, `ats_type`, `ats_slug`, `hq_country`, `company_type`, `pay_policy`, `pay_policy_source`, `verified`, `created_at`) SELECT `id`, `name`, `normalized_name`, `domain`, `ats_type`, `ats_slug`, `hq_country`, `company_type`, `pay_policy`, `pay_policy_source`, `verified`, `created_at` FROM `__old_companies`;--> statement-breakpoint
DROP TABLE `__old_companies`;--> statement-breakpoint
CREATE UNIQUE INDEX `companies_normalized_name_unique` ON `companies` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `intel` (
	`id` text PRIMARY KEY NOT NULL,
	`posting_id` text NOT NULL,
	`status` text NOT NULL,
	`extraction` text,
	`extract_model` text,
	`extract_prompt_version` text,
	`final_decision` text,
	`resolved_reasons` text,
	`scam_score` integer,
	`scam_reasons` text,
	`fit_score` integer,
	`fit_reasons` text,
	`fit_model` text,
	`fit_prompt_version` text,
	`tier` text,
	`ask_idr_month` integer,
	`ask_usd_year` integer,
	`ask_text` text,
	`ask_reason` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `postings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intel_posting_id_unique` ON `intel` (`posting_id`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`model` text NOT NULL,
	`purpose` text NOT NULL,
	`posting_id` text,
	`company_id` text,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cost_usd` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `postings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `postings` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `postings` ADD `updated_at` text;