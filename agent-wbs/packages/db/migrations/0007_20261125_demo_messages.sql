ALTER TABLE "messages" ALTER COLUMN "to_agent" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "delivery" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "from_agent" "agent";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "message_participants" CHECK (("messages"."dir"='out' and "messages"."to_agent" is not null and "messages"."delivery" is not null) or ("messages"."dir"='in' and "messages"."from_agent" is not null));