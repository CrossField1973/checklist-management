ALTER TABLE `users` ADD `totp_enabled_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_last_step` integer;