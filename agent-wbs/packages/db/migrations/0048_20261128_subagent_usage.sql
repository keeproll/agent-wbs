-- 실제 사용한 하위 Agent 기록(UAT-TASK-10 「지정/실제 하위 Agent 표시」의 「실제」 쪽).
-- 누가 쓰나: Runner가 세션이 끝난 뒤 POST /api/runner/attempts/:id/subagent-usage 로 보고한다(contracts §3.2, G §6.7-7).
-- 「지정」 쪽은 새 표가 필요 없다. 실행 시작(jobs/start) 때 이미 attempt_subagents(designated·installed·version)에 남는다.
-- 한 줄 = 시도 하나에서 CLI가 부른 하위 Agent 이름 하나. 우리 정의와 맞으면 subagent·version·def_hash를 채우고, 모르면 비운다(지어내지 않음).
-- 시도·프로젝트가 지워지면 함께 지운다. 그래서 초기화 함수(reset_project)를 고치지 않아도 task_attempts 삭제가 막히지 않는다.
-- 앱(awbs_app)은 읽기·추가·고치기만 한다. 지우기는 초기화 때만(guard_delete).
CREATE TABLE "attempt_subagent_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"attempt" uuid NOT NULL,
	"name" text NOT NULL,
	"subagent" uuid,
	"version" integer,
	"def_hash" text,
	"uses" integer NOT NULL,
	"confirm" text NOT NULL,
	CONSTRAINT "attempt_subagent_usage_attempt_name_unique" UNIQUE("attempt","name"),
	CONSTRAINT "attempt_subagent_usage_name_value" CHECK (length(btrim("attempt_subagent_usage"."name"))>0),
	CONSTRAINT "attempt_subagent_usage_confirm_value" CHECK ("attempt_subagent_usage"."confirm" in ('confirmed', 'partial')),
	CONSTRAINT "subagent_usage_uses" CHECK ("attempt_subagent_usage"."uses" >= 1),
	CONSTRAINT "subagent_usage_def" CHECK (("attempt_subagent_usage"."subagent" is null) = ("attempt_subagent_usage"."version" is null) and ("attempt_subagent_usage"."subagent" is null) = ("attempt_subagent_usage"."def_hash" is null))
);
--> statement-breakpoint
ALTER TABLE "attempt_subagent_usage" ADD CONSTRAINT "attempt_subagent_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 다른 프로젝트의 시도를 가리키지 못하게 (project_id, attempt)로 묶는다(0001·0006의 scope_ 규칙과 같다).
ALTER TABLE "attempt_subagent_usage" ADD CONSTRAINT "scope_attempt_subagent_usage_attempt" FOREIGN KEY ("project_id","attempt") REFERENCES "public"."task_attempts"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_subagent_usage" ADD CONSTRAINT "attempt_subagent_usage_subagent_subagent_defs_id_fk" FOREIGN KEY ("subagent") REFERENCES "public"."subagent_defs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempt_subagent_usage_scope" ON "attempt_subagent_usage"("project_id","attempt");--> statement-breakpoint
CREATE INDEX "attempt_subagent_usage_subagent" ON "attempt_subagent_usage"("subagent");--> statement-breakpoint
ALTER TABLE public.attempt_subagent_usage OWNER TO awbs_data_owner;--> statement-breakpoint
CREATE TRIGGER guard_truncate BEFORE TRUNCATE ON public.attempt_subagent_usage FOR EACH STATEMENT EXECUTE FUNCTION public.awbs_immutable();--> statement-breakpoint
CREATE TRIGGER guard_delete BEFORE DELETE ON public.attempt_subagent_usage FOR EACH ROW EXECUTE FUNCTION public.awbs_delete_guard();--> statement-breakpoint
CREATE TRIGGER touch_updated BEFORE UPDATE ON public.attempt_subagent_usage FOR EACH ROW EXECUTE FUNCTION public.awbs_touch();--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON public.attempt_subagent_usage TO awbs_app;
