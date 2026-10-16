CREATE TABLE `description_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`requested` integer NOT NULL,
	`failed` integer NOT NULL,
	`blocked` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `postings` ADD `description_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `postings` ADD `description_unavailable_at` text;