CREATE TABLE `replays` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`shareable` integer DEFAULT false NOT NULL,
	`schema_version` integer NOT NULL,
	`rules_version` text NOT NULL,
	`policy_version` text NOT NULL,
	`mode` text NOT NULL,
	`seed` integer NOT NULL,
	`action_count` integer NOT NULL,
	`jev_calls` integer DEFAULT 0 NOT NULL,
	`fallback_decisions` integer DEFAULT 0 NOT NULL,
	`winner_policy` text,
	`state_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_replays_expires_at` ON `replays` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_replays_created_at` ON `replays` (`created_at`);--> statement-breakpoint
PRAGMA optimize;
