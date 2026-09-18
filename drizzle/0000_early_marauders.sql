CREATE TABLE `practice_files` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`section` text NOT NULL,
	`storage_key` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `practice_files_storage_key_unique` ON `practice_files` (`storage_key`);--> statement-breakpoint
CREATE INDEX `practice_files_section_idx` ON `practice_files` (`section`);