-- M6-01 보고서 기간 말 재구성(owner 2026-11-27 아이템 13, G L375).
-- 상태 기록(state_log): 보고서가 읽는 「바뀌는 표」의 행이 바뀔 때마다 그 행 전체(to_jsonb)를 추가 전용으로 남긴다.
-- 왜: 기간 지정 보고서는 그 기간 끝 시점의 상태를 되살려야 한다. task_history만으로는 상태·체크리스트·산출물의 그때 값을 모두 알 수 없다.
-- 되살리기: 시각 T 이하의 마지막 기록(op<>'delete')을 jsonb_populate_record로 원래 표 모양의 행으로 바꾼다(apps/api/src/reports/state.ts).
-- 이 표는 Drizzle 스냅샷 밖의 SQL 전용 표다(권한·트리거 중심, 0015와 같은 방식).
CREATE TABLE public.state_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  seq bigserial NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  project_id uuid,
  tbl text NOT NULL,
  row_id uuid NOT NULL,
  op text NOT NULL,
  data jsonb
);
--> statement-breakpoint
CREATE INDEX state_log_asof ON public.state_log (project_id, tbl, row_id, created_at DESC, seq DESC);
--> statement-breakpoint
ALTER TABLE public.state_log OWNER TO awbs_data_owner;
--> statement-breakpoint
REVOKE ALL ON public.state_log FROM awbs_app;
GRANT SELECT, INSERT ON public.state_log TO awbs_app;
GRANT USAGE, SELECT ON SEQUENCE public.state_log_seq_seq TO awbs_app;
--> statement-breakpoint
-- 추가 전용: 고치기·지우기·비우기 금지. 지우기는 초기화(reset_project) 안에서만 된다(awbs_delete_guard).
CREATE TRIGGER append_only BEFORE UPDATE ON public.state_log FOR EACH ROW EXECUTE FUNCTION public.awbs_immutable();
CREATE TRIGGER guard_delete BEFORE DELETE ON public.state_log FOR EACH ROW EXECUTE FUNCTION public.awbs_delete_guard();
CREATE TRIGGER guard_truncate BEFORE TRUNCATE ON public.state_log FOR EACH STATEMENT EXECUTE FUNCTION public.awbs_immutable();
--> statement-breakpoint
-- 기록 시각: 기본은 실제 시각. `awbs.state_at`은 시험·데모 자료를 과거 시점으로 넣을 때만 쓴다(운영 코드는 쓰지 않는다).
-- 초기화 중(awbs.reset=on)의 삭제는 기록하지 않는다. 초기화가 끝나면 아래 reset_log 트리거가 기록 전체를 지운다.
CREATE FUNCTION public.awbs_state_log() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE r pg_catalog.jsonb; at pg_catalog.timestamptz;
BEGIN
  IF pg_catalog.current_setting('awbs.reset', true) = 'on' THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN r := pg_catalog.to_jsonb(OLD); ELSE r := pg_catalog.to_jsonb(NEW); END IF;
  at := coalesce(nullif(pg_catalog.current_setting('awbs.state_at', true), '')::pg_catalog.timestamptz, pg_catalog.clock_timestamp());
  INSERT INTO public.state_log(created_at, project_id, tbl, row_id, op, data)
  VALUES (at, CASE WHEN TG_TABLE_NAME = 'projects' THEN (r->>'id')::uuid ELSE (r->>'project_id')::uuid END,
    TG_TABLE_NAME, (r->>TG_ARGV[0])::uuid, pg_catalog.lower(TG_OP), CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE r END);
  RETURN NULL;
END $$;
--> statement-breakpoint
ALTER FUNCTION public.awbs_state_log() OWNER TO awbs_data_owner;
REVOKE ALL ON FUNCTION public.awbs_state_log() FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE t pg_catalog.text; k pg_catalog.text;
BEGIN
  FOR t, k IN SELECT * FROM (VALUES
    ('projects','id'),('wbs_nodes','id'),('tasks','id'),('task_specs','task'),('task_dependencies','id'),('checklist_items','id'),
    ('task_outputs','id'),('task_grades','id'),('task_attempts','id'),('messages','id'),('change_proposals','id'),('ci_runs','id')) v(t,k) LOOP
    EXECUTE format('CREATE TRIGGER state_log AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.awbs_state_log(%L)', t, k);
    -- 이미 있는 행은 「seed」로 한 번 남긴다. seed보다 이른 시점은 되살릴 수 없다(보고서가 「기록 없음」으로 표시한다).
    EXECUTE format($q$INSERT INTO public.state_log(project_id, tbl, row_id, op, data)
      SELECT %s, %L, (pg_catalog.to_jsonb(x)->>%L)::uuid, 'seed', pg_catalog.to_jsonb(x) FROM public.%I x$q$,
      CASE WHEN t = 'projects' THEN 'x.id' ELSE 'x.project_id' END, t, k, t);
  END LOOP;
END $$;
--> statement-breakpoint
-- 초기화가 끝나면(reset_log 기록) 상태 기록도 지운다. 지우기 권한은 표 소유자이고 awbs.reset=on일 때만이다.
CREATE FUNCTION public.awbs_state_log_reset() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM public.state_log;
  RETURN NULL;
END $$;
--> statement-breakpoint
ALTER FUNCTION public.awbs_state_log_reset() OWNER TO awbs_data_owner;
REVOKE ALL ON FUNCTION public.awbs_state_log_reset() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER state_log_reset AFTER INSERT ON public.reset_log FOR EACH ROW EXECUTE FUNCTION public.awbs_state_log_reset();
