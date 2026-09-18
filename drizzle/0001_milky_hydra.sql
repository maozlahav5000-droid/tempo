CREATE TABLE `practice_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`section` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `practice_folders_section_idx` ON `practice_folders` (`section`);--> statement-breakpoint
ALTER TABLE `practice_files` ADD `folder_id` text;--> statement-breakpoint
CREATE INDEX `practice_files_folder_idx` ON `practice_files` (`folder_id`);