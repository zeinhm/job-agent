CREATE TABLE `apply_links` (
	`id` text PRIMARY KEY NOT NULL,
	`posting_id` text NOT NULL,
	`apply_url` text NOT NULL,
	`apply_type` text NOT NULL,
	`method` text NOT NULL,
	`ats_type` text,
	`ats_slug` text,
	`found_on` text NOT NULL,
	`reason` text,
	`checked_at` text NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `postings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apply_links_posting_id_unique` ON `apply_links` (`posting_id`);--> statement-breakpoint
ALTER TABLE `companies` ADD `ats_checked_at` text;