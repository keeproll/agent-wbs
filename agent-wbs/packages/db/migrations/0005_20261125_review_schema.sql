CREATE TABLE "input_version_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"input_version" uuid NOT NULL,
	"result" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "input_version_results_input_version_unique" UNIQUE("input_version")
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_principal_key_unique";--> statement-breakpoint
ALTER TABLE "replans" DROP CONSTRAINT "replan_status";--> statement-breakpoint
DROP INDEX "one_unsettled_event_outbox";--> statement-breakpoint
DROP INDEX "one_open_alert_key";--> statement-breakpoint
DROP INDEX "one_open_notify_key";--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "change_events" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notify_events" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notify_log" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notify_outbox" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_history" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "change_proposals" ADD COLUMN "split_judgements" jsonb;--> statement-breakpoint
ALTER TABLE "change_proposals" ADD COLUMN "task_judgements" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_jobs" ADD COLUMN "dedup_key" text;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "subagent_defs" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "system_state" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "system_state" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "input_version_results" ADD CONSTRAINT "input_version_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_version_results" ADD CONSTRAINT "input_version_results_input_version_input_versions_id_fk" FOREIGN KEY ("input_version") REFERENCES "public"."input_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_alert_key" ON "alerts" USING btree (coalesce("project_id"::text, 'global'),"key") WHERE "alerts"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_notify_key" ON "notify_events" USING btree (coalesce("project_id"::text, 'global'),"dedup_key") WHERE "notify_events"."resolved_at" is null;--> statement-breakpoint
INSERT INTO public.input_version_results(project_id,input_version,result) SELECT project_id,id,result FROM public.input_versions WHERE result IS NOT NULL;--> statement-breakpoint
ALTER TABLE "input_versions" DROP COLUMN "result";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_project_id_epoch_principal_key_unique" UNIQUE NULLS NOT DISTINCT("project_id","epoch","principal","key");--> statement-breakpoint
ALTER TABLE "notify_outbox" ADD CONSTRAINT "notify_outbox_event_unique" UNIQUE("event");--> statement-breakpoint
ALTER TABLE "runner_jobs" ADD CONSTRAINT "runner_jobs_dedup_key_unique" UNIQUE("dedup_key");--> statement-breakpoint
ALTER TABLE "runner_readiness" ADD CONSTRAINT "runner_readiness_key_unique" UNIQUE("key");--> statement-breakpoint
ALTER TABLE "task_grades" ADD CONSTRAINT "task_grades_task_role_unique" UNIQUE("task","role");--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_task_name_unique" UNIQUE("task","name");--> statement-breakpoint
ALTER TABLE "task_splits" ADD CONSTRAINT "task_splits_task_unique" UNIQUE("task");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_severity_value" CHECK (length(btrim("alerts"."severity"))>0);--> statement-breakpoint
ALTER TABLE "attempt_observations" ADD CONSTRAINT "attempt_observations_grade_value" CHECK ("attempt_observations"."grade" in ('ok', 'partial', 'unver'));--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_topic_value" CHECK ("change_events"."topic" in ('task', 'dependency', 'attempt', 'verification', 'message', 'proposal', 'planning', 'schedule', 'runner', 'ci', 'design', 'report', 'mail', 'notify', 'alert', 'project', 'settings'));--> statement-breakpoint
ALTER TABLE "change_proposal_events" ADD CONSTRAINT "change_proposal_events_kind_value" CHECK (length(btrim("change_proposal_events"."kind"))>0);--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "cp_task_judgements_array" CHECK (jsonb_typeof("change_proposals"."task_judgements")='array');--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "cp_judgements_shape" CHECK (public.awbs_valid_judgements("change_proposals"."split_judgements", ARRAY['ac_meaning','layer_order','test_included']));--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "hold_reasons_shape" CHECK (public.awbs_valid_hold_reasons("change_proposals"."hold_reasons"));--> statement-breakpoint
ALTER TABLE "cli_observation_grades" ADD CONSTRAINT "cli_observation_grades_grade_value" CHECK ("cli_observation_grades"."grade" in ('ok', 'partial', 'unver'));--> statement-breakpoint
ALTER TABLE "counters" ADD CONSTRAINT "counters_kind_value" CHECK (length(btrim("counters"."kind"))>0);--> statement-breakpoint
ALTER TABLE "defect_events" ADD CONSTRAINT "defect_events_kind_value" CHECK (length(btrim("defect_events"."kind"))>0);--> statement-breakpoint
ALTER TABLE "design_drifts" ADD CONSTRAINT "design_drifts_kind_value" CHECK (length(btrim("design_drifts"."kind"))>0);--> statement-breakpoint
ALTER TABLE "design_drifts" ADD CONSTRAINT "design_drifts_status_value" CHECK (length(btrim("design_drifts"."status"))>0);--> statement-breakpoint
ALTER TABLE "design_edges" ADD CONSTRAINT "design_edges_kind_value" CHECK (length(btrim("design_edges"."kind"))>0);--> statement-breakpoint
ALTER TABLE "design_files" ADD CONSTRAINT "design_files_parse_status_value" CHECK (length(btrim("design_files"."parse_status"))>0);--> statement-breakpoint
ALTER TABLE "design_files" ADD CONSTRAINT "design_files_format_value" CHECK (length(btrim("design_files"."format"))>0);--> statement-breakpoint
ALTER TABLE "design_items" ADD CONSTRAINT "design_items_kind_value" CHECK (length(btrim("design_items"."kind"))>0);--> statement-breakpoint
ALTER TABLE "design_snapshots" ADD CONSTRAINT "design_snapshots_parse_status_value" CHECK (length(btrim("design_snapshots"."parse_status"))>0);--> statement-breakpoint
ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_kind_value" CHECK (length(btrim("design_versions"."kind"))>0);--> statement-breakpoint
ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_status_value" CHECK (length(btrim("design_versions"."status"))>0);--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_kind_value" CHECK (length(btrim("evidence"."kind"))>0);--> statement-breakpoint
ALTER TABLE "execution_holds" ADD CONSTRAINT "hold_lock_target" CHECK ("execution_holds"."lock_state"<>'held' or "execution_holds"."task" is not null or "execution_holds"."conflict_group" is not null);--> statement-breakpoint
ALTER TABLE "execution_holds" ADD CONSTRAINT "hold_orphaned_slots" CHECK ("execution_holds"."lock_state"<>'orphaned' or "execution_holds"."slot_state" in ('none','unconfirmed'));--> statement-breakpoint
ALTER TABLE "execution_holds" ADD CONSTRAINT "hold_active_group" CHECK ("execution_holds"."slot_state"<>'active' or coalesce("execution_holds"."pgid">0,false) or coalesce(length("execution_holds"."cgroup")>0,false));--> statement-breakpoint
ALTER TABLE "github_settings" ADD CONSTRAINT "github_settings_mode_value" CHECK (length(btrim("github_settings"."mode"))>0);--> statement-breakpoint
ALTER TABLE "github_settings" ADD CONSTRAINT "github_settings_status_value" CHECK (length(btrim("github_settings"."status"))>0);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_dir_value" CHECK ("messages"."dir" in ('in', 'out'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_type_value" CHECK ("messages"."type" in ('추가 지시', '수정 요청', '질문', '일반 의견', '응답'));--> statement-breakpoint
ALTER TABLE "notify_events" ADD CONSTRAINT "notify_events_kind_value" CHECK (length(btrim("notify_events"."kind"))>0);--> statement-breakpoint
ALTER TABLE "notify_log" ADD CONSTRAINT "notify_log_kind_value" CHECK ("notify_log"."kind" in ('biz', 'test'));--> statement-breakpoint
ALTER TABLE "notify_outbox" ADD CONSTRAINT "notify_outbox_kind_value" CHECK ("notify_outbox"."kind" in ('biz', 'test'));--> statement-breakpoint
ALTER TABLE "notify_rules" ADD CONSTRAINT "notify_rules_key_value" CHECK ("notify_rules"."key" in ('done', 'fail', 'admin', 'approve', 'buildOk', 'buildFail'));--> statement-breakpoint
ALTER TABLE "planning_reviews" ADD CONSTRAINT "planning_reviews_kind_value" CHECK (length(btrim("planning_reviews"."kind"))>0);--> statement-breakpoint
ALTER TABLE "plannings" ADD CONSTRAINT "plannings_status_value" CHECK (length(btrim("plannings"."status"))>0);--> statement-breakpoint
ALTER TABLE "replan_moves" ADD CONSTRAINT "replan_moves_kind_value" CHECK (length(btrim("replan_moves"."kind"))>0);--> statement-breakpoint
ALTER TABLE "replans" ADD CONSTRAINT "replan_status" CHECK ("replans"."status" in ('applied','pending','discarded'));--> statement-breakpoint
ALTER TABLE "repo_checks" ADD CONSTRAINT "repo_checks_status_value" CHECK ("repo_checks"."status" in ('queued', 'running', 'done', 'failed'));--> statement-breakpoint
ALTER TABLE "reset_log" ADD CONSTRAINT "reset_log_runner_cleanup_status_value" CHECK ("reset_log"."runner_cleanup_status" in ('pending', 'running', 'done', 'failed'));--> statement-breakpoint
ALTER TABLE "runner_commands" ADD CONSTRAINT "runner_commands_status_value" CHECK ("runner_commands"."status" in ('pending', 'running', 'done', 'failed'));--> statement-breakpoint
ALTER TABLE "runner_readiness" ADD CONSTRAINT "runner_readiness_key_value" CHECK (length(btrim("runner_readiness"."key"))>0);--> statement-breakpoint
ALTER TABLE "runner_readiness" ADD CONSTRAINT "runner_readiness_status_value" CHECK ("runner_readiness"."status" in ('ok', 'warn', 'fail'));--> statement-breakpoint
ALTER TABLE "subagent_defs" ADD CONSTRAINT "subagent_defs_role_value" CHECK (length(btrim("subagent_defs"."role"))>0);--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "attempt_end_time" CHECK (("task_attempts"."status"='running' and "task_attempts"."ended_at" is null) or ("task_attempts"."status"<>'running' and "task_attempts"."ended_at">="task_attempts"."started_at" and "task_attempts"."ended_at" is not null));--> statement-breakpoint
ALTER TABLE "task_design_items" ADD CONSTRAINT "task_design_items_change_value" CHECK (length(btrim("task_design_items"."change"))>0);--> statement-breakpoint
ALTER TABLE "task_estimates" ADD CONSTRAINT "task_estimates_confidence_value" CHECK ("task_estimates"."confidence" in ('상', '중', '하'));--> statement-breakpoint
ALTER TABLE "task_history" ADD CONSTRAINT "task_history_kind_value" CHECK (length(btrim("task_history"."kind"))>0);--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_kind_value" CHECK (length(btrim("task_outputs"."kind"))>0);--> statement-breakpoint
ALTER TABLE "task_splits" ADD CONSTRAINT "split_judgements_shape" CHECK (public.awbs_valid_judgements("task_splits"."judged_rules", ARRAY['revert','contract','refactor']));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_verif_state_value" CHECK ("tasks"."verif_state" in ('none', 'running', 'pass', 'fail', 'blocked'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "related_domains_no_null" CHECK (array_position("tasks"."related_domains",null) is null);--> statement-breakpoint
ALTER TABLE "tech_decision_events" ADD CONSTRAINT "tech_decision_events_kind_value" CHECK (length(btrim("tech_decision_events"."kind"))>0);--> statement-breakpoint
ALTER TABLE "wbs_drafts" ADD CONSTRAINT "wbs_drafts_status_value" CHECK (length(btrim("wbs_drafts"."status"))>0);