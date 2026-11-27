-- job이 없는 야간 점검도 시작한 Runner만 갱신한다.
ALTER TABLE public.ci_runs ADD COLUMN IF NOT EXISTS reporter text;
--> statement-breakpoint
ALTER TABLE public.ci_steps ADD COLUMN IF NOT EXISTS duration_ms bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.ci_steps'::regclass AND conname='ci_step_duration') THEN ALTER TABLE public.ci_steps ADD CONSTRAINT ci_step_duration CHECK (duration_ms >= 0 AND duration_ms <= 9007199254740991); END IF; END $$;
--> statement-breakpoint
-- H→H′ 보존 증거를 남겨 자동 완료와 팀장 완료 버튼이 같은 근거를 쓴다.
ALTER TABLE public.merge_queue ADD COLUMN IF NOT EXISTS head_sync jsonb;
--> statement-breakpoint
ALTER TABLE public.merge_queue ADD COLUMN IF NOT EXISTS merge_parents jsonb;
--> statement-breakpoint
-- 번호는 벽시계가 뒤로 가도 새 ① 검사와 대기열을 구분한다.
ALTER TABLE public.ci_runs ADD COLUMN run_no bigserial NOT NULL;
--> statement-breakpoint
-- 과거 행은 기존 선택 순서를 보존하고, 새 행부터 증가 번호를 사용한다.
WITH ordered AS (SELECT id,row_number() OVER (ORDER BY created_at,id) n FROM public.ci_runs)
UPDATE public.ci_runs c SET run_no=o.n FROM ordered o WHERE o.id=c.id;
--> statement-breakpoint
SELECT setval('public.ci_runs_run_no_seq',coalesce((SELECT max(run_no) FROM public.ci_runs),1),EXISTS(SELECT 1 FROM public.ci_runs));
--> statement-breakpoint
ALTER TABLE public.ci_runs ADD CONSTRAINT ci_runs_run_no_unique UNIQUE(run_no);
--> statement-breakpoint
ALTER TABLE public.merge_queue ADD COLUMN queue_no bigserial NOT NULL;
--> statement-breakpoint
WITH ordered AS (SELECT id,row_number() OVER (ORDER BY created_at,id) n FROM public.merge_queue)
UPDATE public.merge_queue q SET queue_no=o.n FROM ordered o WHERE o.id=q.id;
--> statement-breakpoint
SELECT setval('public.merge_queue_queue_no_seq',coalesce((SELECT max(queue_no) FROM public.merge_queue),1),EXISTS(SELECT 1 FROM public.merge_queue));
--> statement-breakpoint
ALTER TABLE public.merge_queue ADD CONSTRAINT merge_queue_queue_no_unique UNIQUE(queue_no);
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE public.ci_runs_run_no_seq,public.merge_queue_queue_no_seq TO awbs_app;
--> statement-breakpoint
ALTER TABLE public.ci_runs ADD COLUMN fail_scope text;
--> statement-breakpoint
ALTER TABLE public.ci_runs ADD CONSTRAINT ci_fail_scope CHECK (fail_scope IS NULL OR fail_scope IN ('baseline','task'));
--> statement-breakpoint
ALTER TABLE public.projects ADD COLUMN pipeline_observations jsonb NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE public.ci_settings ADD COLUMN settings_version timestamptz;
--> statement-breakpoint
-- Runner 관측은 팀장 편집 버전과 구분한다.
CREATE OR REPLACE FUNCTION public.awbs_touch_project() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.created_at := OLD.created_at;
  IF (NEW.input_checked_at IS DISTINCT FROM OLD.input_checked_at OR NEW.pipeline_observations IS DISTINCT FROM OLD.pipeline_observations)
     AND (to_jsonb(NEW) - ARRAY['input_checked_at','pipeline_observations','updated_at']) = (to_jsonb(OLD) - ARRAY['input_checked_at','pipeline_observations','updated_at']) THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := greatest(clock_timestamp(), OLD.updated_at + interval '1 microsecond');
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
-- 수신 순번으로 최신 상태를 고른다. 기존 기록은 과거 정렬을 한 번만 보존한다.
DO $$ DECLARE t text; ordering text; old_role text := current_setting('session_replication_role'); BEGIN
  PERFORM set_config('session_replication_role','replica',true);
  FOREACH t IN ARRAY ARRAY['planning_jobs','task_estimates','change_proposals','runner_jobs','task_attempts','attempt_observations','runner_hosts','runner_concurrency_log','agent_usage','task_history','ci_steps','runner_sessions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN record_no bigserial NOT NULL',t);
    ordering := CASE WHEN t='runner_hosts' THEN 'seen_at,created_at,id' WHEN t IN ('attempt_observations','task_history') THEN 'at,created_at,id' WHEN t IN ('task_attempts','runner_sessions') THEN 'started_at,created_at,id' ELSE 'created_at,id' END;
    EXECUTE format('WITH ordered AS (SELECT id,row_number() OVER (ORDER BY %s) n FROM public.%I) UPDATE public.%I r SET record_no=o.n FROM ordered o WHERE o.id=r.id',ordering,t,t);
    EXECUTE format('SELECT setval(%L,coalesce((SELECT max(record_no) FROM public.%I),1),EXISTS(SELECT 1 FROM public.%I))','public.'||t||'_record_no_seq',t,t);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE(record_no)',t,t||'_record_no_unique');
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO awbs_app',t||'_record_no_seq');
  END LOOP;
  PERFORM set_config('session_replication_role',old_role,true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('session_replication_role',old_role,true);
  RAISE;
END $$;
--> statement-breakpoint
-- Git 객체의 사실은 같은 SHA로 다시 보고해도 고칠 수 없다.
CREATE TABLE public.ci_merge_facts(project_id uuid NOT NULL CONSTRAINT ci_merge_facts_project_id_projects_id_fk REFERENCES public.projects(id) ON DELETE CASCADE,merge_sha text NOT NULL,tree_sha text,parents jsonb,CONSTRAINT ci_merge_facts_project_id_merge_sha_pk PRIMARY KEY(project_id,merge_sha));
--> statement-breakpoint
INSERT INTO public.ci_merge_facts(project_id,merge_sha,tree_sha,parents)
SELECT DISTINCT ON (project_id,actual_merge_sha) project_id,actual_merge_sha,actual_tree_sha,merge_parents
FROM public.merge_queue WHERE actual_merge_sha IS NOT NULL ORDER BY project_id,actual_merge_sha,queue_no;
--> statement-breakpoint
ALTER TABLE public.ci_merge_facts OWNER TO awbs_data_owner;
--> statement-breakpoint
CREATE TRIGGER guard_truncate BEFORE TRUNCATE ON public.ci_merge_facts FOR EACH STATEMENT EXECUTE FUNCTION public.awbs_immutable();
CREATE TRIGGER guard_delete BEFORE DELETE ON public.ci_merge_facts FOR EACH ROW EXECUTE FUNCTION public.awbs_delete_guard();
--> statement-breakpoint
GRANT SELECT,INSERT ON public.ci_merge_facts TO awbs_app;
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE ON public.ci_merge_facts FOR EACH ROW EXECUTE FUNCTION public.awbs_immutable();

--> statement-breakpoint
-- 모르는 화면 값은 null로 둔다. Runner가 실제 관측한 값만 기록한다.
ALTER TABLE public.ci_runs ADD COLUMN note text,ADD COLUMN e2e jsonb,ADD COLUMN github_status jsonb,ADD COLUMN finished_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.merge_queue ADD COLUMN merged_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.flaky_tests ADD COLUMN last_failed_at timestamptz;
