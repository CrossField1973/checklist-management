ALTER TABLE `users` ADD `accent` text DEFAULT 'blue' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `font_size` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `hide_done` integer DEFAULT false NOT NULL;