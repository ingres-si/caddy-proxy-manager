-- Needs attention lists open alerts now; they are dismissed for everyone
-- through alert_silences, so the per-account dismissals of drizzle-pg/0062
-- go. Built-in alert rules (ee/alerting/builtins.ts) carry their key in
-- alert_rules.builtIn. drizzle/0064 has the same change for SQLite.
DROP TABLE IF EXISTS "attention_dismissals" CASCADE;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "builtIn" text;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_rules_built_in_unique" ON "alert_rules" USING btree ("builtIn");
