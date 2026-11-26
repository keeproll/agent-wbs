CREATE TYPE "public"."agent" AS ENUM('Claude', 'Codex');--> statement-breakpoint
CREATE TYPE "public"."attempt_kind" AS ENUM('dev', 'qa', 'rework', 'reverify');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('running', 'completed', 'failed', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."decision_authority" AS ENUM('lead', 'agent', 'free');--> statement-breakpoint
CREATE TYPE "public"."input_change_state" AS ENUM('pending', 'skipped', 'analyzed');--> statement-breakpoint
CREATE TYPE "public"."ci_status" AS ENUM('queued', 'run', 'pass', 'fail', 'skip');--> statement-breakpoint
CREATE TYPE "public"."cleanup_status" AS ENUM('none', 'pending', 'running', 'failed');--> statement-breakpoint
CREATE TYPE "public"."decision_status" AS ENUM('fixed', 'approved', 'pending', 'rejected', 'noted', 'change');--> statement-breakpoint
CREATE TYPE "public"."delivery_state" AS ENUM('queued', 'sending', 'accepted', 'retry_wait', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."dependency_type" AS ENUM('FS', 'SS');--> statement-breakpoint
CREATE TYPE "public"."task_design_kind" AS ENUM('DB', 'API', 'FE', 'DevOps');--> statement-breakpoint
CREATE TYPE "public"."domain" AS ENUM('FE', 'BE', 'DB', 'DevOps', 'API', 'QA', 'Architecture', 'Common');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('repo_check', 'bootstrap', 'input_diff', 'planning', 'estimate', 'split', 'attempt', 'stop_attempt', 'integrate', 'deploy_check', 'ci_retry', 'design_apply', 'merge_followup');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('queued', 'leased', 'started', 'reconcile', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lock_state" AS ENUM('none', 'held', 'handed_over', 'released', 'orphaned');--> statement-breakpoint
CREATE TYPE "public"."message_delivery" AS ENUM('Draft', 'Queued', 'Sent', 'Acknowledged', 'Cancelled', 'Failed');--> statement-breakpoint
CREATE TYPE "public"."node_kind" AS ENUM('phase', 'work_package');--> statement-breakpoint
CREATE TYPE "public"."project_phase" AS ENUM('boot', 'active');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('draft', 'review', 'approved', 'applied', 'changes', 'rejected', 'held');--> statement-breakpoint
CREATE TYPE "public"."queue_status" AS ENUM('waiting_verify', 'queued', 'checking', 'merged', 'failed', 'removed');--> statement-breakpoint
CREATE TYPE "public"."release_proof" AS ENUM('no_process', 'group_empty', 'boot_changed');--> statement-breakpoint
CREATE TYPE "public"."report_kind" AS ENUM('daily', 'weekly', 'custom');--> statement-breakpoint
CREATE TYPE "public"."report_view" AS ENUM('int', 'ext');--> statement-breakpoint
CREATE TYPE "public"."task_role" AS ENUM('dev', 'qa');--> statement-breakpoint
CREATE TYPE "public"."slot_state" AS ENUM('none', 'reserved', 'active', 'unconfirmed');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('wait', 'run', 'done', 'fail');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('planning', 'approval', 'ready', 'running', 'qa', 'verifying', 'rework', 'paused', 'failed', 'gate', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."tech_level" AS ENUM('must', 'cond', 'ban');--> statement-breakpoint
CREATE TYPE "public"."verification_result" AS ENUM('PASS', 'FAIL', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."work_type" AS ENUM('Analysis', 'Design', 'Implementation', 'Configuration', 'Test', 'Verification', 'Documentation', 'Integration');--> statement-breakpoint
CREATE TABLE "agent_efforts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent" "agent" NOT NULL,
	"model_id" text NOT NULL,
	"value" text NOT NULL,
	"common_level" integer,
	"supported" boolean,
	"confirmation" text NOT NULL,
	CONSTRAINT "agent_efforts_agent_model_id_value_unique" UNIQUE("agent","model_id","value"),
	CONSTRAINT "effort_level" CHECK ("agent_efforts"."common_level" between 1 and 5),
	CONSTRAINT "effort_no_ultra" CHECK ("agent_efforts"."value"<>'ultra' or "agent_efforts"."common_level" is null)
);
--> statement-breakpoint
CREATE TABLE "agent_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent" "agent" NOT NULL,
	"model_id" text NOT NULL,
	"rank" integer,
	"allowed" boolean DEFAULT false NOT NULL,
	"is_new" boolean DEFAULT true NOT NULL,
	"report" jsonb,
	CONSTRAINT "agent_models_agent_model_id_unique" UNIQUE("agent","model_id")
);
--> statement-breakpoint
CREATE TABLE "agent_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent" "agent" NOT NULL,
	"remain_pct" numeric NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"tokens_used" bigint,
	CONSTRAINT "usage_percent" CHECK ("agent_usage"."remain_pct" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"severity" text NOT NULL,
	"target" jsonb NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"app_url" text,
	"heartbeat_seconds" integer NOT NULL,
	"heartbeat_misses" integer NOT NULL,
	"split" jsonb NOT NULL,
	"workflow" jsonb,
	"stage_pct" jsonb NOT NULL,
	"timezone" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "app_settings_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "app_singleton" CHECK ("app_settings"."singleton"),
	CONSTRAINT "heartbeat_positive" CHECK ("app_settings"."heartbeat_seconds">0 and "app_settings"."heartbeat_misses">0)
);
--> statement-breakpoint
CREATE TABLE "attempt_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"attempt" uuid NOT NULL,
	"path" text NOT NULL,
	CONSTRAINT "attempt_files_attempt_path_unique" UNIQUE("attempt","path"),
	CONSTRAINT "relative_file_path" CHECK ("attempt_files"."path"<>'' and "attempt_files"."path" !~ '(^/|(^|/)..(/|$)|\)')
);
--> statement-breakpoint
CREATE TABLE "attempt_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"attempt" uuid NOT NULL,
	"cli" text NOT NULL,
	"version" text NOT NULL,
	"grade" text NOT NULL,
	"observed" integer,
	"reserved" integer NOT NULL,
	"state" text NOT NULL,
	"process_state" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "observation_state" CHECK ("attempt_observations"."state" in ('ok','unconfirmed'))
);
--> statement-breakpoint
CREATE TABLE "attempt_subagents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"attempt" uuid NOT NULL,
	"subagent" uuid NOT NULL,
	"designated" boolean NOT NULL,
	"installed" boolean NOT NULL,
	"observed_used" boolean,
	"version" integer NOT NULL,
	"def_hash" text NOT NULL,
	"confirm" text,
	CONSTRAINT "usage_confirmation" CHECK ("attempt_subagents"."confirm" in ('confirmed','partial'))
);
--> statement-breakpoint
CREATE TABLE "baseline_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"baseline" uuid NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"lo" timestamp with time zone NOT NULL,
	"hi" timestamp with time zone NOT NULL,
	CONSTRAINT "baseline_items_baseline_task_unique" UNIQUE("baseline","task")
);
--> statement-breakpoint
CREATE TABLE "blackout_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"date" date NOT NULL,
	"note" text NOT NULL,
	CONSTRAINT "blackout_days_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "change_events" (
	"project_id" uuid NOT NULL,
	"seq" bigserial PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"ref" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_proposal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"proposal" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"comment" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"cp_key" text NOT NULL,
	"source" text NOT NULL,
	"status" "proposal_status" NOT NULL,
	"ops" jsonb NOT NULL,
	"id_map" jsonb,
	"preview_hash" text,
	"hold_reasons" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "change_proposals_cp_key_unique" UNIQUE("cp_key"),
	CONSTRAINT "proposal_source" CHECK ("change_proposals"."source" in ('planning','message','manual','split','input','decision'))
);
--> statement-breakpoint
CREATE TABLE "checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"item_key" text NOT NULL,
	"content" text NOT NULL,
	"required" boolean NOT NULL,
	"done" boolean NOT NULL,
	"verify_method" text NOT NULL,
	"evidence" jsonb,
	"note" text,
	"sort_order" integer NOT NULL,
	CONSTRAINT "checklist_items_task_item_key_unique" UNIQUE("task","item_key")
);
--> statement-breakpoint
CREATE TABLE "ci_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_key" text NOT NULL,
	"stage" integer NOT NULL,
	"base_sha" text,
	"head_sha" text,
	"merge_sha" text,
	"tree_sha" text,
	"pipeline_sha" text NOT NULL,
	"ref" text NOT NULL,
	"pr" integer,
	"task" uuid,
	"attempt" uuid,
	"trigger" text NOT NULL,
	"status" "ci_status" NOT NULL,
	"fail_step" text,
	"log_excerpt" text,
	"artifact_path" text,
	"url" text,
	CONSTRAINT "ci_runs_run_key_unique" UNIQUE("run_key"),
	CONSTRAINT "ci_stage" CHECK ("ci_runs"."stage" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "ci_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"night_at" text,
	"retry" integer NOT NULL,
	"deploy_url" text,
	CONSTRAINT "ci_settings_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "ci_singleton" CHECK ("ci_settings"."singleton")
);
--> statement-breakpoint
CREATE TABLE "ci_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"run" uuid NOT NULL,
	"step_key" text NOT NULL,
	"status" "ci_status" NOT NULL,
	"command" text NOT NULL,
	"exit_code" integer,
	"log_excerpt" text,
	CONSTRAINT "ci_steps_run_step_key_unique" UNIQUE("run","step_key")
);
--> statement-breakpoint
CREATE TABLE "cli_observation_grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cli" text NOT NULL,
	"version" text NOT NULL,
	"model" text NOT NULL,
	"options" text NOT NULL,
	"grade" text NOT NULL,
	"verified_at" timestamp with time zone,
	"notes" text NOT NULL,
	CONSTRAINT "cli_observation_grades_cli_version_model_options_unique" UNIQUE("cli","version","model","options")
);
--> statement-breakpoint
CREATE TABLE "concurrency_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"mode" text NOT NULL,
	"caps" jsonb,
	"mem_reserve_gb" numeric,
	"subagent_budget" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "concurrency_settings_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "concurrency_singleton" CHECK ("concurrency_settings"."singleton"),
	CONSTRAINT "concurrency_mode" CHECK ("concurrency_settings"."mode" in ('auto','manual'))
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" bigint NOT NULL,
	CONSTRAINT "counters_project_id_kind_unique" UNIQUE("project_id","kind"),
	CONSTRAINT "counter_positive" CHECK ("counters"."value">0)
);
--> statement-breakpoint
CREATE TABLE "defect_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"defect" uuid NOT NULL,
	"kind" text NOT NULL,
	"resolved_by_verification" uuid,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "defects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"def_key" text NOT NULL,
	"verification" uuid NOT NULL,
	"blocking" boolean NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "defects_def_key_unique" UNIQUE("def_key")
);
--> statement-breakpoint
CREATE TABLE "design_drifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"kind" text NOT NULL,
	"compat" text NOT NULL,
	"status" text NOT NULL,
	"resolution" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "drift_compat" CHECK ("design_drifts"."compat" in ('호환','깨짐','대조 안 함'))
);
--> statement-breakpoint
CREATE TABLE "design_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"snapshot" uuid NOT NULL,
	"from_item" uuid NOT NULL,
	"to_item" uuid NOT NULL,
	"kind" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"snapshot" uuid NOT NULL,
	"path" text NOT NULL,
	"format" text NOT NULL,
	"parse_status" text NOT NULL,
	"content" jsonb,
	"last_success" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"error" text,
	CONSTRAINT "design_files_snapshot_path_unique" UNIQUE("snapshot","path")
);
--> statement-breakpoint
CREATE TABLE "design_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"snapshot" uuid NOT NULL,
	"file" uuid,
	"item_key" text NOT NULL,
	"kind" text NOT NULL,
	"content" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "design_items_snapshot_item_key_unique" UNIQUE("snapshot","item_key")
);
--> statement-breakpoint
CREATE TABLE "design_ownership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"snapshot" uuid NOT NULL,
	"item_key" text NOT NULL,
	"owner" text NOT NULL,
	"task" uuid
);
--> statement-breakpoint
CREATE TABLE "design_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"commit" text NOT NULL,
	"ref" text NOT NULL,
	"parse_status" text NOT NULL,
	"error" text,
	CONSTRAINT "design_snapshots_project_id_commit_ref_unique" UNIQUE("project_id","commit","ref")
);
--> statement-breakpoint
CREATE TABLE "design_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"kind" text NOT NULL,
	"compat" text NOT NULL,
	"status" text NOT NULL,
	"resolution" jsonb,
	"snapshot" uuid NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"attempt" uuid,
	"verification" uuid,
	"checklist" uuid,
	"kind" text NOT NULL,
	"storage_path" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	CONSTRAINT "evidence_hash_size" CHECK ("evidence"."sha256" ~ '^[a-f0-9]{64}$' and "evidence"."size">=0)
);
--> statement-breakpoint
CREATE TABLE "exec_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"on_usage" text NOT NULL,
	"low_pct" integer,
	"on_rework" text NOT NULL,
	"esc_notify" integer NOT NULL,
	"floors" jsonb NOT NULL,
	"live_inject" boolean DEFAULT false NOT NULL,
	"auto_retry_limit" integer NOT NULL,
	"auto_rework_limit" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "exec_policy_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "exec_singleton" CHECK ("exec_policy"."singleton"),
	CONSTRAINT "exec_usage" CHECK ("exec_policy"."on_usage" in ('wait','down')),
	CONSTRAINT "exec_rework" CHECK ("exec_policy"."on_rework" in ('same','up1','top')),
	CONSTRAINT "exec_limits" CHECK ("exec_policy"."auto_retry_limit">=0 and "exec_policy"."auto_rework_limit">=0)
);
--> statement-breakpoint
CREATE TABLE "execution_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid,
	"job" uuid NOT NULL,
	"attempt" uuid,
	"epoch" integer NOT NULL,
	"host_id" text,
	"boot_id" text,
	"fence" integer,
	"pgid" integer,
	"cgroup" text,
	"task" uuid,
	"conflict_group" text,
	"agent" "agent" NOT NULL,
	"slots" integer NOT NULL,
	"heavy" boolean NOT NULL,
	"slot_state" "slot_state" NOT NULL,
	"lock_state" "lock_state" NOT NULL,
	"lock_from_job" uuid,
	"handed_to_job" uuid,
	"release_proof" "release_proof",
	"closed_at" timestamp with time zone,
	CONSTRAINT "execution_holds_job_unique" UNIQUE("job"),
	CONSTRAINT "hold_slots" CHECK ("execution_holds"."slots">=0),
	CONSTRAINT "hold_closed" CHECK (("execution_holds"."closed_at" is null) = ("execution_holds"."slot_state"<>'none' or "execution_holds"."lock_state"='held')),
	CONSTRAINT "handover_slots" CHECK ("execution_holds"."lock_state" not in ('handed_over','released') or "execution_holds"."slot_state"='none'),
	CONSTRAINT "handover_target" CHECK ("execution_holds"."lock_state"<>'handed_over' or "execution_holds"."handed_to_job" is not null)
);
--> statement-breakpoint
CREATE TABLE "external_write_authority" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"host_id" text NOT NULL,
	"generation" integer NOT NULL,
	"state" text NOT NULL,
	"credential_fingerprint" text,
	"blocked_reason" text,
	"reconciled_at" timestamp with time zone,
	CONSTRAINT "external_write_authority_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "external_singleton" CHECK ("external_write_authority"."singleton"),
	CONSTRAINT "external_state" CHECK ("external_write_authority"."state" in ('granted','blocked'))
);
--> statement-breakpoint
CREATE TABLE "file_delete_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"epoch" integer NOT NULL,
	"path" text NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "file_delete_queue_epoch_path_unique" UNIQUE("epoch","path")
);
--> statement-breakpoint
CREATE TABLE "flaky_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"test_key" text NOT NULL,
	"rate" numeric NOT NULL,
	"quarantined" boolean NOT NULL,
	"task" uuid,
	CONSTRAINT "flaky_tests_test_key_unique" UNIQUE("test_key"),
	CONSTRAINT "flaky_rate" CHECK ("flaky_tests"."rate" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "github_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"account" text,
	"secret_key" text,
	CONSTRAINT "github_settings_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "github_singleton" CHECK ("github_settings"."singleton")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"principal" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"epoch" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "idempotency_keys_principal_key_unique" UNIQUE("principal","key")
);
--> statement-breakpoint
CREATE TABLE "input_change_commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"files" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"state" "input_change_state" NOT NULL,
	"analyzed_in_version" uuid,
	CONSTRAINT "input_change_commits_project_id_sha_unique" UNIQUE("project_id","sha")
);
--> statement-breakpoint
CREATE TABLE "input_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"v" integer NOT NULL,
	"commit_sha" text NOT NULL,
	"files" jsonb NOT NULL,
	"md_list" jsonb NOT NULL,
	"changes" jsonb NOT NULL,
	"instruction" text NOT NULL,
	"result" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "input_versions_project_id_v_unique" UNIQUE("project_id","v"),
	CONSTRAINT "input_versions_project_id_commit_sha_unique" UNIQUE("project_id","commit_sha"),
	CONSTRAINT "input_version_positive" CHECK ("input_versions"."v">0)
);
--> statement-breakpoint
CREATE TABLE "lead_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"password_hash" text NOT NULL,
	CONSTRAINT "lead_credentials_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "lead_credentials_singleton" CHECK ("lead_credentials"."singleton")
);
--> statement-breakpoint
CREATE TABLE "lead_login_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "lead_login_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "lead_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"csrf" text NOT NULL,
	CONSTRAINT "lead_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mail_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"report" uuid NOT NULL,
	"email" text NOT NULL,
	"state" "delivery_state" NOT NULL,
	"error" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"report" uuid NOT NULL,
	"recipient" uuid NOT NULL,
	"email" text NOT NULL,
	"try_no" integer NOT NULL,
	"state" "delivery_state" NOT NULL,
	"next_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "mail_outbox_report_recipient_try_no_unique" UNIQUE("report","recipient","try_no"),
	CONSTRAINT "mail_try_positive" CHECK ("mail_outbox"."try_no">0)
);
--> statement-breakpoint
CREATE TABLE "mail_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean NOT NULL,
	"daily" boolean NOT NULL,
	"weekly" boolean NOT NULL,
	"pdf" boolean NOT NULL,
	"view" "report_view" NOT NULL,
	CONSTRAINT "recipient_schedule" CHECK (not "mail_recipients"."active" or "mail_recipients"."daily" or "mail_recipients"."weekly")
);
--> statement-breakpoint
CREATE TABLE "mail_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"host" text,
	"port" integer,
	"security" text,
	"from" text,
	"user" text,
	"secret_key" text,
	"checked_at" timestamp with time zone,
	"status" text,
	"error" text,
	CONSTRAINT "mail_settings_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "mail_singleton" CHECK ("mail_settings"."singleton")
);
--> statement-breakpoint
CREATE TABLE "merge_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"pr" integer NOT NULL,
	"position" integer NOT NULL,
	"status" "queue_status" NOT NULL,
	"qa_head_sha" text NOT NULL,
	"synced_head_sha" text,
	"base_sha" text,
	"verification" uuid NOT NULL,
	"ci_run" uuid,
	"tested_tree_sha" text,
	"actual_merge_sha" text,
	"actual_tree_sha" text
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"msg_key" text NOT NULL,
	"attempt" uuid,
	"dir" text NOT NULL,
	"type" text NOT NULL,
	"to_agent" "agent" NOT NULL,
	"body" text NOT NULL,
	"delivery" "message_delivery" NOT NULL,
	"pending_next" boolean NOT NULL,
	"work_state" text NOT NULL,
	"fail_reason" text,
	"read_at" timestamp with time zone,
	"draft" boolean NOT NULL,
	CONSTRAINT "messages_msg_key_unique" UNIQUE("msg_key")
);
--> statement-breakpoint
CREATE TABLE "notify_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"dedup_key" text NOT NULL,
	"kind" text NOT NULL,
	"ref" jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"dup_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notify_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" "delivery_state" NOT NULL,
	"error" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notify_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"event" uuid,
	"delivery_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"state" "delivery_state" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"kind" text NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "notify_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "notify_rules_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "notify_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"enabled" boolean NOT NULL,
	"chat_id" text,
	"target_name" text,
	"bot" jsonb,
	"test_fingerprint" text,
	"secret_key" text,
	CONSTRAINT "notify_settings_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "notify_singleton" CHECK ("notify_settings"."singleton")
);
--> statement-breakpoint
CREATE TABLE "planning_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"planning" uuid NOT NULL,
	"agent" "agent" NOT NULL,
	"analysis" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "planning_analyses_planning_agent_unique" UNIQUE("planning","agent")
);
--> statement-breakpoint
CREATE TABLE "planning_job_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"job" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planning_job_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"job" uuid NOT NULL,
	"step_key" text NOT NULL,
	"status" "step_status" NOT NULL,
	"note" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "planning_job_steps_job_step_key_unique" UNIQUE("job","step_key")
);
--> statement-breakpoint
CREATE TABLE "planning_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"run_no" integer NOT NULL,
	"status" text NOT NULL,
	"fail" jsonb,
	"instruction" text NOT NULL,
	CONSTRAINT "planning_kind" CHECK ("planning_jobs"."kind" in ('bootstrap','input_diff','planning','estimate','split')),
	CONSTRAINT "planning_status" CHECK ("planning_jobs"."status" in ('queued','running','done','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "planning_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"planning" uuid NOT NULL,
	"topic" text NOT NULL,
	"kind" text NOT NULL,
	"codex" jsonb NOT NULL,
	"claude" jsonb NOT NULL,
	"choice" text,
	"memo" text,
	"schema_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plannings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"planning_key" text NOT NULL,
	"title" text NOT NULL,
	"scope" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "plannings_planning_key_unique" UNIQUE("planning_key")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"repo_url" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"base_commit" text,
	"target_date" date,
	"lead_instruction" text NOT NULL,
	"phase" "project_phase" NOT NULL,
	CONSTRAINT "projects_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "project_singleton" CHECK ("projects"."singleton"),
	CONSTRAINT "project_main" CHECK ("projects"."branch"='main')
);
--> statement-breakpoint
CREATE TABLE "replan_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"replan" uuid NOT NULL,
	"kind" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"rp_key" text NOT NULL,
	"trigger" text NOT NULL,
	"actor" text NOT NULL,
	"baseline_v" integer,
	"status" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "replans_rp_key_unique" UNIQUE("rp_key"),
	CONSTRAINT "replan_status" CHECK ("replans"."status" in ('applied','pending'))
);
--> statement-breakpoint
CREATE TABLE "repo_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid,
	"url" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "report_pdfs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"report" uuid NOT NULL,
	"view" "report_view" NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "report_pdfs_report_view_unique" UNIQUE("report","view")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"report_key" text NOT NULL,
	"kind" "report_kind" NOT NULL,
	"from" date NOT NULL,
	"to" date NOT NULL,
	"view" "report_view" DEFAULT 'int' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"reason" text NOT NULL,
	CONSTRAINT "reports_report_key_unique" UNIQUE("report_key"),
	CONSTRAINT "report_period" CHECK ("reports"."from"<="reports"."to")
);
--> statement-breakpoint
CREATE TABLE "reset_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"epoch" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"deleted_task_count" integer NOT NULL,
	"keep_settings" boolean NOT NULL,
	"runner_cleanup_status" text NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "reset_log_epoch_unique" UNIQUE("epoch")
);
--> statement-breakpoint
CREATE TABLE "runner_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"epoch" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	CONSTRAINT "command_kind" CHECK ("runner_commands"."kind"='reset-cleanup')
);
--> statement-breakpoint
CREATE TABLE "runner_concurrency_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"host_id" text NOT NULL,
	"limit" integer NOT NULL,
	"running" integer NOT NULL,
	"subagents" jsonb NOT NULL,
	"heavy" integer NOT NULL,
	"resources" jsonb NOT NULL,
	"adjust" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"host_id" text NOT NULL,
	"cpu" text NOT NULL,
	"cores" integer NOT NULL,
	"mem_gb" numeric NOT NULL,
	"swap_gb" numeric NOT NULL,
	"disk_gb" numeric NOT NULL,
	"os" text NOT NULL,
	"per_session_gb" numeric,
	"samples" integer NOT NULL,
	"seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid,
	"job" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text,
	"detail" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "job_event_kind" CHECK ("runner_job_events"."kind" in ('prepared','prestart_failed','started','lease_lost','reconciled','finished'))
);
--> statement-breakpoint
CREATE TABLE "runner_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid,
	"kind" "job_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"state" "job_state" NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"fence" integer DEFAULT 0 NOT NULL,
	"epoch" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"generation" integer
);
--> statement-breakpoint
CREATE TABLE "runner_readiness" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"status" text NOT NULL,
	"detail" text NOT NULL,
	"fix" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"runner_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"last_heartbeat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token_hash" text NOT NULL,
	"runner_id" text NOT NULL,
	"public_key" text NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "runner_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "schedule_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"v" integer NOT NULL,
	"expected" jsonb NOT NULL,
	"range" jsonb NOT NULL,
	"applied_rate" numeric NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "schedule_baselines_project_id_v_unique" UNIQUE("project_id","v")
);
--> statement-breakpoint
CREATE TABLE "schedule_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"auto_replan" boolean,
	"cp_auto" boolean,
	"threshold_days" numeric,
	"assume_rate" numeric,
	"window_days" integer NOT NULL,
	"min_hours" integer NOT NULL,
	CONSTRAINT "schedule_policy_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "schedule_singleton" CHECK ("schedule_policy"."singleton"),
	CONSTRAINT "assume_rate_range" CHECK ("schedule_policy"."assume_rate" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"key" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"key_version" integer NOT NULL,
	"last4" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subagent_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"def_key" text NOT NULL,
	"version" integer NOT NULL,
	"agent" "agent" NOT NULL,
	"role" text NOT NULL,
	"tools" text[] NOT NULL,
	"sandbox" text NOT NULL,
	"text" text NOT NULL,
	"hash" text NOT NULL,
	"allowed" boolean DEFAULT false NOT NULL,
	"ref" text,
	CONSTRAINT "subagent_defs_def_key_version_unique" UNIQUE("def_key","version")
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"cleanup_status" "cleanup_status" DEFAULT 'none' NOT NULL,
	CONSTRAINT "system_state_singleton" CHECK ("system_state"."id"=1),
	CONSTRAINT "epoch_positive" CHECK ("system_state"."epoch">0)
);
--> statement-breakpoint
CREATE TABLE "task_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"attempt_key" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"branch" text,
	"pr" integer,
	"generation" integer,
	"job" uuid NOT NULL,
	"base_sha" text NOT NULL,
	"head_sha" text NOT NULL,
	"spec_revision" integer NOT NULL,
	"input_version" uuid,
	"kind" "attempt_kind" NOT NULL,
	"agent" "agent" NOT NULL,
	"status" "attempt_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"model_id" text NOT NULL,
	"effort" text NOT NULL,
	"grade_adjust" jsonb,
	"summary" text,
	"failure" jsonb,
	"tokens" bigint,
	"resumed_from" uuid,
	CONSTRAINT "task_attempts_attempt_key_unique" UNIQUE("attempt_key"),
	CONSTRAINT "task_attempts_job_unique" UNIQUE("job"),
	CONSTRAINT "task_attempts_task_attempt_no_unique" UNIQUE("task","attempt_no"),
	CONSTRAINT "attempt_number_positive" CHECK ("task_attempts"."attempt_no">0)
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"pred" uuid NOT NULL,
	"succ" uuid NOT NULL,
	"dep_type" "dependency_type" NOT NULL,
	CONSTRAINT "task_dependencies_pred_succ_unique" UNIQUE("pred","succ"),
	CONSTRAINT "dependency_not_self" CHECK ("task_dependencies"."pred"<>"task_dependencies"."succ")
);
--> statement-breakpoint
CREATE TABLE "task_design_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"item_key" text NOT NULL,
	"change" text NOT NULL,
	CONSTRAINT "task_design_items_task_item_key_unique" UNIQUE("task","item_key")
);
--> statement-breakpoint
CREATE TABLE "task_designs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"kind" "task_design_kind" NOT NULL,
	"content" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "task_designs_task_kind_unique" UNIQUE("task","kind")
);
--> statement-breakpoint
CREATE TABLE "task_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"est" numeric NOT NULL,
	"lo" numeric NOT NULL,
	"hi" numeric NOT NULL,
	"tokens_k" numeric,
	"confidence" text NOT NULL,
	"basis" text NOT NULL,
	"agreed_by" text NOT NULL,
	CONSTRAINT "estimate_bounds" CHECK (0<="task_estimates"."lo" and "task_estimates"."lo"<="task_estimates"."est" and "task_estimates"."est"<="task_estimates"."hi")
);
--> statement-breakpoint
CREATE TABLE "task_grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"role" "task_role" NOT NULL,
	"model_id" text NOT NULL,
	"effort" text NOT NULL,
	"reason" text NOT NULL,
	"locked" boolean NOT NULL,
	"locked_by" text,
	"effective_from" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"task" uuid,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ref" jsonb
);
--> statement-breakpoint
CREATE TABLE "task_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"required" boolean NOT NULL,
	"verify" text NOT NULL,
	"delivered" boolean NOT NULL,
	"delivered_attempt" uuid
);
--> statement-breakpoint
CREATE TABLE "task_source_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"fix_task" uuid NOT NULL,
	"origin_task" uuid,
	"split_from" uuid
);
--> statement-breakpoint
CREATE TABLE "task_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"overview" jsonb NOT NULL,
	"spec" jsonb NOT NULL,
	"ac" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "task_specs_task_unique" UNIQUE("task"),
	CONSTRAINT "ac_array" CHECK (jsonb_typeof("task_specs"."ac")='array')
);
--> statement-breakpoint
CREATE TABLE "task_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"basis" text NOT NULL,
	"judged_rules" jsonb NOT NULL,
	"exceptions" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_subagents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" uuid NOT NULL,
	"role" "task_role" NOT NULL,
	"subagent_id" uuid NOT NULL,
	"basis" text NOT NULL,
	CONSTRAINT "task_subagents_task_role_subagent_id_unique" UNIQUE("task","role","subagent_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"wbs_node_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"title" text NOT NULL,
	"work_type" "work_type" NOT NULL,
	"primary_domain" "domain" NOT NULL,
	"related_domains" "domain"[] NOT NULL,
	"priority" integer NOT NULL,
	"assignee_agent" "agent" NOT NULL,
	"verifier_agent" "agent" NOT NULL,
	"status" "task_status" NOT NULL,
	"verif_state" text NOT NULL,
	"planning_approved_at" timestamp with time zone,
	"fix_start" date,
	"act_start" timestamp with time zone,
	"act_end" timestamp with time zone,
	"conflict_group" text,
	"src_input_version" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tasks_task_key_unique" UNIQUE("task_key"),
	CONSTRAINT "task_title_length" CHECK (char_length("tasks"."title") between 1 and 200),
	CONSTRAINT "task_priority" CHECK ("tasks"."priority" between 0 and 3),
	CONSTRAINT "task_related_domains" CHECK ("tasks"."primary_domain" <> all("tasks"."related_domains"))
);
--> statement-breakpoint
CREATE TABLE "tech_constraints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"level" "tech_level" NOT NULL,
	"condition" text
);
--> statement-breakpoint
CREATE TABLE "tech_decision_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"decision" uuid NOT NULL,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tech_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"td_key" text NOT NULL,
	"title" text NOT NULL,
	"authority" "decision_authority" NOT NULL,
	"status" "decision_status" NOT NULL,
	"content" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tech_decisions_td_key_unique" UNIQUE("td_key")
);
--> statement-breakpoint
CREATE TABLE "verification_invalidations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"verification" uuid NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"attempt" uuid NOT NULL,
	"result" "verification_result" NOT NULL,
	"head_sha" text NOT NULL,
	"spec_revision" integer NOT NULL,
	"cmd" text NOT NULL,
	"expected" text NOT NULL,
	"actual" text NOT NULL,
	CONSTRAINT "verifications_attempt_unique" UNIQUE("attempt")
);
--> statement-breakpoint
CREATE TABLE "wbs_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"job" uuid NOT NULL,
	"revision" integer NOT NULL,
	"content" jsonb NOT NULL,
	"split_check" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "wbs_drafts_job_revision_unique" UNIQUE("job","revision")
);
--> statement-breakpoint
CREATE TABLE "wbs_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"kind" "node_kind" NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "wbs_nodes_node_key_unique" UNIQUE("node_key"),
	CONSTRAINT "node_parent" CHECK (("wbs_nodes"."kind"='phase' and "wbs_nodes"."parent_id" is null) or ("wbs_nodes"."kind"='work_package' and "wbs_nodes"."parent_id" is not null)),
	CONSTRAINT "node_not_self" CHECK ("wbs_nodes"."parent_id"<>"wbs_nodes"."id")
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_files" ADD CONSTRAINT "attempt_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_files" ADD CONSTRAINT "attempt_files_attempt_task_attempts_id_fk" FOREIGN KEY ("attempt") REFERENCES "public"."task_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_observations" ADD CONSTRAINT "attempt_observations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_observations" ADD CONSTRAINT "attempt_observations_attempt_task_attempts_id_fk" FOREIGN KEY ("attempt") REFERENCES "public"."task_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_subagents" ADD CONSTRAINT "attempt_subagents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_subagents" ADD CONSTRAINT "attempt_subagents_attempt_task_attempts_id_fk" FOREIGN KEY ("attempt") REFERENCES "public"."task_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_subagents" ADD CONSTRAINT "attempt_subagents_subagent_subagent_defs_id_fk" FOREIGN KEY ("subagent") REFERENCES "public"."subagent_defs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_items" ADD CONSTRAINT "baseline_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_items" ADD CONSTRAINT "baseline_items_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_items" ADD CONSTRAINT "baseline_items_baseline_schedule_baselines_id_fk" FOREIGN KEY ("baseline") REFERENCES "public"."schedule_baselines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_proposal_events" ADD CONSTRAINT "change_proposal_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_proposal_events" ADD CONSTRAINT "change_proposal_events_proposal_change_proposals_id_fk" FOREIGN KEY ("proposal") REFERENCES "public"."change_proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "change_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_attempt_task_attempts_id_fk" FOREIGN KEY ("attempt") REFERENCES "public"."task_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_steps" ADD CONSTRAINT "ci_steps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_steps" ADD CONSTRAINT "ci_steps_run_ci_runs_id_fk" FOREIGN KEY ("run") REFERENCES "public"."ci_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counters" ADD CONSTRAINT "counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_events" ADD CONSTRAINT "defect_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_events" ADD CONSTRAINT "defect_events_defect_defects_id_fk" FOREIGN KEY ("defect") REFERENCES "public"."defects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_events" ADD CONSTRAINT "defect_events_resolved_by_verification_verifications_id_fk" FOREIGN KEY ("resolved_by_verification") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_verification_verifications_id_fk" FOREIGN KEY ("verification") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_drifts" ADD CONSTRAINT "design_drifts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_edges" ADD CONSTRAINT "design_edges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_edges" ADD CONSTRAINT "design_edges_snapshot_design_snapshots_id_fk" FOREIGN KEY ("snapshot") REFERENCES "public"."design_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_edges" ADD CONSTRAINT "design_edges_from_item_design_items_id_fk" FOREIGN KEY ("from_item") REFERENCES "public"."design_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_edges" ADD CONSTRAINT "design_edges_to_item_design_items_id_fk" FOREIGN KEY ("to_item") REFERENCES "public"."design_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_files" ADD CONSTRAINT "design_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_files" ADD CONSTRAINT "design_files_snapshot_design_snapshots_id_fk" FOREIGN KEY ("snapshot") REFERENCES "public"."design_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_items" ADD CONSTRAINT "design_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_items" ADD CONSTRAINT "design_items_snapshot_design_snapshots_id_fk" FOREIGN KEY ("snapshot") REFERENCES "public"."design_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_items" ADD CONSTRAINT "design_items_file_design_files_id_fk" FOREIGN KEY ("file") REFERENCES "public"."design_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_ownership" ADD CONSTRAINT "design_ownership_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_ownership" ADD CONSTRAINT "design_ownership_snapshot_design_snapshots_id_fk" FOREIGN KEY ("snapshot") REFERENCES "public"."design_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_ownership" ADD CONSTRAINT "design_ownership_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_snapshots" ADD CONSTRAINT "design_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_snapshot_design_snapshots_id_fk" FOREIGN KEY ("snapshot") REFERENCES "public"."design_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_attempt_task_attempts_id_fk" FOREIGN KEY ("attempt") REFERENCES "public"."task_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_verification_verifications_id_fk" FOREIGN KEY ("verification") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_checklist_checklist_items_id_fk" FOREIGN KEY ("checklist") REFERENCES "public"."checklist_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_holds" ADD CONSTRAINT "execution_holds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_holds" ADD CONSTRAINT "execution_holds_job_runner_jobs_id_fk" FOREIGN KEY ("job") REFERENCES "public"."runner_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_holds" ADD CONSTRAINT "execution_holds_attempt_task_attempts_id_fk" FOREIGN KEY ("attempt") REFERENCES "public"."task_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_holds" ADD CONSTRAINT "execution_holds_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_holds" ADD CONSTRAINT "execution_holds_lock_from_job_runner_jobs_id_fk" FOREIGN KEY ("lock_from_job") REFERENCES "public"."runner_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_holds" ADD CONSTRAINT "execution_holds_handed_to_job_runner_jobs_id_fk" FOREIGN KEY ("handed_to_job") REFERENCES "public"."runner_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flaky_tests" ADD CONSTRAINT "flaky_tests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flaky_tests" ADD CONSTRAINT "flaky_tests_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_settings" ADD CONSTRAINT "github_settings_secret_key_secrets_key_fk" FOREIGN KEY ("secret_key") REFERENCES "public"."secrets"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_change_commits" ADD CONSTRAINT "input_change_commits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_change_commits" ADD CONSTRAINT "input_change_commits_analyzed_in_version_input_versions_id_fk" FOREIGN KEY ("analyzed_in_version") REFERENCES "public"."input_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_versions" ADD CONSTRAINT "input_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_report_reports_id_fk" FOREIGN KEY ("report") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_report_reports_id_fk" FOREIGN KEY ("report") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_settings" ADD CONSTRAINT "mail_settings_secret_key_secrets_key_fk" FOREIGN KEY ("secret_key") REFERENCES "public"."secrets"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_verification_verifications_id_fk" FOREIGN KEY ("verification") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_ci_run_ci_runs_id_fk" FOREIGN KEY ("ci_run") REFERENCES "public"."ci_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attempt_task_attempts_id_fk" FOREIGN KEY ("attempt") REFERENCES "public"."task_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify_events" ADD CONSTRAINT "notify_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify_log" ADD CONSTRAINT "notify_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify_outbox" ADD CONSTRAINT "notify_outbox_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify_outbox" ADD CONSTRAINT "notify_outbox_event_notify_events_id_fk" FOREIGN KEY ("event") REFERENCES "public"."notify_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify_settings" ADD CONSTRAINT "notify_settings_secret_key_secrets_key_fk" FOREIGN KEY ("secret_key") REFERENCES "public"."secrets"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_analyses" ADD CONSTRAINT "planning_analyses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_analyses" ADD CONSTRAINT "planning_analyses_planning_plannings_id_fk" FOREIGN KEY ("planning") REFERENCES "public"."plannings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_job_logs" ADD CONSTRAINT "planning_job_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_job_logs" ADD CONSTRAINT "planning_job_logs_job_planning_jobs_id_fk" FOREIGN KEY ("job") REFERENCES "public"."planning_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_job_steps" ADD CONSTRAINT "planning_job_steps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_job_steps" ADD CONSTRAINT "planning_job_steps_job_planning_jobs_id_fk" FOREIGN KEY ("job") REFERENCES "public"."planning_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_jobs" ADD CONSTRAINT "planning_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_reviews" ADD CONSTRAINT "planning_reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_reviews" ADD CONSTRAINT "planning_reviews_planning_plannings_id_fk" FOREIGN KEY ("planning") REFERENCES "public"."plannings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plannings" ADD CONSTRAINT "plannings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replan_moves" ADD CONSTRAINT "replan_moves_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replan_moves" ADD CONSTRAINT "replan_moves_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replan_moves" ADD CONSTRAINT "replan_moves_replan_replans_id_fk" FOREIGN KEY ("replan") REFERENCES "public"."replans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replans" ADD CONSTRAINT "replans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_checks" ADD CONSTRAINT "repo_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_pdfs" ADD CONSTRAINT "report_pdfs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_pdfs" ADD CONSTRAINT "report_pdfs_report_reports_id_fk" FOREIGN KEY ("report") REFERENCES "public"."reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_job_events" ADD CONSTRAINT "runner_job_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_job_events" ADD CONSTRAINT "runner_job_events_job_runner_jobs_id_fk" FOREIGN KEY ("job") REFERENCES "public"."runner_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_jobs" ADD CONSTRAINT "runner_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_baselines" ADD CONSTRAINT "schedule_baselines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_job_runner_jobs_id_fk" FOREIGN KEY ("job") REFERENCES "public"."runner_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_input_version_input_versions_id_fk" FOREIGN KEY ("input_version") REFERENCES "public"."input_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_resumed_from_task_attempts_id_fk" FOREIGN KEY ("resumed_from") REFERENCES "public"."task_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_pred_tasks_id_fk" FOREIGN KEY ("pred") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_succ_tasks_id_fk" FOREIGN KEY ("succ") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_design_items" ADD CONSTRAINT "task_design_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_design_items" ADD CONSTRAINT "task_design_items_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_designs" ADD CONSTRAINT "task_designs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_designs" ADD CONSTRAINT "task_designs_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_estimates" ADD CONSTRAINT "task_estimates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_estimates" ADD CONSTRAINT "task_estimates_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_grades" ADD CONSTRAINT "task_grades_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_grades" ADD CONSTRAINT "task_grades_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_history" ADD CONSTRAINT "task_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_history" ADD CONSTRAINT "task_history_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_delivered_attempt_task_attempts_id_fk" FOREIGN KEY ("delivered_attempt") REFERENCES "public"."task_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_source_links" ADD CONSTRAINT "task_source_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_source_links" ADD CONSTRAINT "task_source_links_fix_task_tasks_id_fk" FOREIGN KEY ("fix_task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_source_links" ADD CONSTRAINT "task_source_links_origin_task_tasks_id_fk" FOREIGN KEY ("origin_task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_source_links" ADD CONSTRAINT "task_source_links_split_from_tasks_id_fk" FOREIGN KEY ("split_from") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_specs" ADD CONSTRAINT "task_specs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_specs" ADD CONSTRAINT "task_specs_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_splits" ADD CONSTRAINT "task_splits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_splits" ADD CONSTRAINT "task_splits_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_subagents" ADD CONSTRAINT "task_subagents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_subagents" ADD CONSTRAINT "task_subagents_task_tasks_id_fk" FOREIGN KEY ("task") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_subagents" ADD CONSTRAINT "task_subagents_subagent_id_subagent_defs_id_fk" FOREIGN KEY ("subagent_id") REFERENCES "public"."subagent_defs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_wbs_node_id_wbs_nodes_id_fk" FOREIGN KEY ("wbs_node_id") REFERENCES "public"."wbs_nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_src_input_version_input_versions_id_fk" FOREIGN KEY ("src_input_version") REFERENCES "public"."input_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_constraints" ADD CONSTRAINT "tech_constraints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_decision_events" ADD CONSTRAINT "tech_decision_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_decision_events" ADD CONSTRAINT "tech_decision_events_decision_tech_decisions_id_fk" FOREIGN KEY ("decision") REFERENCES "public"."tech_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_decisions" ADD CONSTRAINT "tech_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_invalidations" ADD CONSTRAINT "verification_invalidations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_invalidations" ADD CONSTRAINT "verification_invalidations_verification_verifications_id_fk" FOREIGN KEY ("verification") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_attempt_task_attempts_id_fk" FOREIGN KEY ("attempt") REFERENCES "public"."task_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wbs_drafts" ADD CONSTRAINT "wbs_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wbs_drafts" ADD CONSTRAINT "wbs_drafts_job_planning_jobs_id_fk" FOREIGN KEY ("job") REFERENCES "public"."planning_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_parent_id_wbs_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."wbs_nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_alert_key" ON "alerts" USING btree ("key") WHERE "alerts"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "one_task_lock" ON "execution_holds" USING btree ("task") WHERE "execution_holds"."lock_state"='held';--> statement-breakpoint
CREATE UNIQUE INDEX "one_conflict_lock" ON "execution_holds" USING btree ("conflict_group") WHERE "execution_holds"."lock_state"='held' and "execution_holds"."conflict_group" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "recipient_email_lower" ON "mail_recipients" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_merge_task" ON "merge_queue" USING btree ("task") WHERE "merge_queue"."status" in ('waiting_verify','queued','checking');--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_notify_key" ON "notify_events" USING btree ("dedup_key") WHERE "notify_events"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "one_unsettled_event_outbox" ON "notify_outbox" USING btree ("event") WHERE "notify_outbox"."state" in ('queued','sending','retry_wait','unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_bootstrap" ON "planning_jobs" USING btree ("project_id") WHERE "planning_jobs"."kind"='bootstrap' and "planning_jobs"."status" in ('queued','running');--> statement-breakpoint
CREATE UNIQUE INDEX "one_periodic_report" ON "reports" USING btree ("project_id","kind","from","to") WHERE "reports"."kind" in ('daily','weekly');--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_attempt" ON "task_attempts" USING btree ("task") WHERE "task_attempts"."status"='running';