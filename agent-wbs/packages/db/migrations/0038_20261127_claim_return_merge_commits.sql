ALTER TABLE "runner_job_events" DROP CONSTRAINT "job_event_kind";--> statement-breakpoint
ALTER TABLE "ci_merge_facts" ADD COLUMN "commit_parents" jsonb;--> statement-breakpoint
ALTER TABLE "runner_job_events" ADD CONSTRAINT "job_event_kind" CHECK ("runner_job_events"."kind" in ('prepared','prestart_failed','returned','started','lease_lost','reconciled','finished'));