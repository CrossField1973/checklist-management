CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`permission` text NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `password_resets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `password_resets_token_hash_unique` ON `password_resets` (`token_hash`);--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_items` (
	`id` text PRIMARY KEY NOT NULL,
	`section_id` text NOT NULL,
	`parent_item_id` text,
	`title` text NOT NULL,
	`description` text,
	`position` integer DEFAULT 0 NOT NULL,
	`is_checked` integer DEFAULT false NOT NULL,
	`checked_at` integer,
	FOREIGN KEY (`section_id`) REFERENCES `run_sections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_item_id`) REFERENCES `run_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_items_section` ON `run_items` (`section_id`);--> statement-breakpoint
CREATE INDEX `run_items_parent` ON `run_items` (`parent_item_id`);--> statement-breakpoint
CREATE TABLE `run_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`source_template_id` text,
	`title` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `run_sections_run` ON `run_sections` (`run_id`);--> statement-breakpoint
CREATE TABLE `run_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`access` text NOT NULL,
	`password_hash` text,
	`permission` text NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_shares_token_hash_unique` ON `run_shares` (`token_hash`);--> statement-breakpoint
CREATE INDEX `run_shares_run` ON `run_shares` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	`deleted_at` integer,
	`status_before_delete` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_owner` ON `runs` (`owner_id`,`status`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_user_name` ON `tags` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `template_items` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`parent_item_id` text,
	`title` text NOT NULL,
	`description` text,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_item_id`) REFERENCES `template_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `template_items_tpl` ON `template_items` (`template_id`);--> statement-breakpoint
CREATE INDEX `template_items_parent` ON `template_items` (`parent_item_id`);--> statement-breakpoint
CREATE TABLE `template_tags` (
	`template_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`template_id`, `tag_id`),
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `templates_owner` ON `templates` (`owner_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_provider_subject` ON `user_identities` (`provider`,`subject`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text,
	`language` text DEFAULT 'de' NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`trash_retention_days` integer,
	`totp_secret` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);