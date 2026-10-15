CREATE TABLE `answer_bank` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`group` text NOT NULL,
	`question` text,
	`answer` text NOT NULL,
	`type` text,
	`choices` text,
	`alternatives` text,
	`approved` integer DEFAULT false NOT NULL,
	`approved_at` text,
	`source` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `answer_bank_key_unique` ON `answer_bank` (`key`);--> statement-breakpoint
CREATE TABLE `posting_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`posting_id` text NOT NULL,
	`ats_type` text NOT NULL,
	`question_id` text NOT NULL,
	`label` text NOT NULL,
	`required` integer NOT NULL,
	`type` text NOT NULL,
	`options` text,
	`normalized_label` text NOT NULL,
	`matched_key` text,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `postings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `posting_questions_label` ON `posting_questions` (`normalized_label`);--> statement-breakpoint
CREATE UNIQUE INDEX `posting_questions_posting_question` ON `posting_questions` (`posting_id`,`question_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`posting_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`note` text,
	`apply_url` text,
	`pay_policy` text,
	`reviewed_at` text NOT NULL,
	`review_day` text NOT NULL,
	`fit_score` integer,
	`final_decision` text,
	`tier` text,
	`apply_type` text,
	`extract_prompt_version` text,
	`fit_prompt_version` text,
	FOREIGN KEY (`posting_id`) REFERENCES `postings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reviews_posting` ON `reviews` (`posting_id`,`reviewed_at`);--> statement-breakpoint
CREATE INDEX `reviews_day` ON `reviews` (`review_day`);--> statement-breakpoint
CREATE TABLE `unknown_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`normalized_label` text NOT NULL,
	`label` text NOT NULL,
	`posting_count` integer NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`answer_key` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unknown_questions_normalized_label_unique` ON `unknown_questions` (`normalized_label`);