CREATE TABLE `lesson_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`lesson_date` text DEFAULT '' NOT NULL,
	`body_html` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lesson_notes_sort_idx` ON `lesson_notes` (`lesson_date`,`updated_at`);