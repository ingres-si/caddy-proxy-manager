-- Items of "Needs attention" an account hid from its own overview
-- (src/lib/attention/dismissals.ts): one row per account and item, until a
-- time. The userId reference is not enforced: deleting a user deletes its
-- rows in code.
CREATE TABLE `attention_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`source` text NOT NULL,
	`itemId` text NOT NULL,
	`severity` text NOT NULL,
	`until` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attention_dismissals_item_unique` ON `attention_dismissals` (`userId`,`source`,`itemId`);
