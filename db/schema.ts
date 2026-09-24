import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const replays = sqliteTable("replays", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  shareable: integer("shareable", { mode: "boolean" }).notNull().default(false),
  schemaVersion: integer("schema_version").notNull(),
  rulesVersion: text("rules_version").notNull(),
  policyVersion: text("policy_version").notNull(),
  mode: text("mode").notNull(),
  seed: integer("seed").notNull(),
  actionCount: integer("action_count").notNull(),
  jevCalls: integer("jev_calls").notNull().default(0),
  fallbackDecisions: integer("fallback_decisions").notNull().default(0),
  winnerPolicy: text("winner_policy"),
  stateJson: text("state_json").notNull(),
}, (table) => [
  index("idx_replays_expires_at").on(table.expiresAt),
  index("idx_replays_created_at").on(table.createdAt),
]);
