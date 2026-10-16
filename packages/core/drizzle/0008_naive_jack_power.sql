CREATE TABLE `choice_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`answer_key` text NOT NULL,
	`normalized_label` text NOT NULL,
	`options_hash` text NOT NULL,
	`options` text NOT NULL,
	`chosen` text NOT NULL,
	`approved` integer DEFAULT false NOT NULL,
	`approved_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `choice_mappings_unique` ON `choice_mappings` (`answer_key`,`normalized_label`,`options_hash`);--> statement-breakpoint
CREATE TABLE `dry_run_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`dry_run_id` text NOT NULL,
	`label` text NOT NULL,
	`field_type` text NOT NULL,
	`required` integer NOT NULL,
	`source` text NOT NULL,
	`answer_key` text,
	`value` text,
	`filled` integer NOT NULL,
	`note` text,
	FOREIGN KEY (`dry_run_id`) REFERENCES `dry_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dry_run_fields_run` ON `dry_run_fields` (`dry_run_id`);--> statement-breakpoint
CREATE TABLE `dry_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`posting_id` text NOT NULL,
	`ats_type` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`status` text NOT NULL,
	`stop_reason` text,
	`stop_detail` text,
	`screenshot_path` text,
	`review` text,
	`review_reason` text,
	`review_note` text,
	`reviewed_at` text,
	`fixture` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `postings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dry_runs_posting` ON `dry_runs` (`posting_id`);--> statement-breakpoint
CREATE INDEX `dry_runs_started` ON `dry_runs` (`started_at`);