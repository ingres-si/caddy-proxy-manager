ALTER TABLE "user_preferences" ADD COLUMN "proxyHostsSort" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "l4ProxyHostsSort" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "clientCertificatesSort" text DEFAULT 'default' NOT NULL;