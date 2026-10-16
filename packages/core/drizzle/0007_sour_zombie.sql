ALTER TABLE `description_runs` ADD `fetched` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `description_runs` ADD `skipped` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `postings` ADD `description_failed_at` text;--> statement-breakpoint
ALTER TABLE `postings` ADD `description_blocked_at` text;