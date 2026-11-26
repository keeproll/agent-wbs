-- M1 통합: API가 요구하지만 저장할 곳이 없던 값. 이 파일 전에 저장한 행은 아래처럼 채운다.
ALTER TABLE "change_proposals" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "change_proposals" ADD COLUMN "reason" text;--> statement-breakpoint
UPDATE "change_proposals" SET "title"="cp_key", "reason"='이전 버전에서 저장되어 사유가 없음';--> statement-breakpoint
ALTER TABLE "change_proposals" ALTER COLUMN "title" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "change_proposals" ALTER COLUMN "reason" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "change_proposals" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "job" uuid;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "fence" integer;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_hosts" ADD COLUMN "boot_id" text;--> statement-breakpoint
-- 다른 프로젝트의 job을 가리키지 못하게 프로젝트 범위 FK만 둔다(0001·0006과 같은 방식). 선두 인덱스도 만든다.
ALTER TABLE "ci_runs" ADD CONSTRAINT "scope_ci_runs_job" FOREIGN KEY ("project_id","job") REFERENCES "public"."runner_jobs"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_runs_job" ON "ci_runs" ("project_id","job");--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "cp_title_text" CHECK (length(btrim("change_proposals"."title"))>0);--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "cp_reason_text" CHECK (length(btrim("change_proposals"."reason"))>0);--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "cp_source_id_text" CHECK ("change_proposals"."source_id" is null or length(btrim("change_proposals"."source_id"))>0);--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "cp_split_source" CHECK ("change_proposals"."source"<>'split' or "change_proposals"."source_id" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_job_owner" CHECK ("ci_runs"."stage"=3 or "ci_runs"."job" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_job_fence" CHECK (("ci_runs"."job" is null)=("ci_runs"."fence" is null) and ("ci_runs"."fence" is null or "ci_runs"."fence">=0));--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_artifacts_array" CHECK (jsonb_typeof("ci_runs"."artifacts")='array');--> statement-breakpoint
ALTER TABLE "runner_hosts" ADD CONSTRAINT "runner_host_boot_text" CHECK ("runner_hosts"."boot_id" is null or length(btrim("runner_hosts"."boot_id"))>0);