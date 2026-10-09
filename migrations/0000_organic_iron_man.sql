CREATE TABLE `chat_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`language` text DEFAULT 'en',
	`timezone` text DEFAULT 'UTC',
	`summary_style` text DEFAULT 'detailed',
	`notion_database_id` text,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_configs_chat_id_unique` ON `chat_configs` (`chat_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`user_name` text,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`reply_to_message_id` integer,
	`forward_from_name` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`message_ids` text,
	`created_at` integer
);
