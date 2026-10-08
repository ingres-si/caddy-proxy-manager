-- Needs attention lists open alerts now; they are dismissed for everyone
-- through alert_silences, so the per-account dismissals of 0062 go.
-- Built-in alert rules (ee/alerting/builtins.ts) carry their key in
-- alert_rules.builtIn.
DROP TABLE IF EXISTS `attention_dismissals`;--> statement-breakpoint
ALTER TABLE `alert_rules` ADD `builtIn` text;--> statement-breakpoint
CREATE UNIQUE INDEX `alert_rules_built_in_unique` ON `alert_rules` (`builtIn`);
