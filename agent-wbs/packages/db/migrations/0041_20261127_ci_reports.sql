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
