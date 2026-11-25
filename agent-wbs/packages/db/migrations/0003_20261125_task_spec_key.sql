ALTER TABLE "task_specs" DROP CONSTRAINT "task_specs_task_unique";--> statement-breakpoint
ALTER TABLE "task_specs" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "task_specs" ADD PRIMARY KEY ("task");
