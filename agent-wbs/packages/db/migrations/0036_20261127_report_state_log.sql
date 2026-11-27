-- M6-01 보고서 기간 말 재구성의 상태 이력(owner 2026-11-27 아이템 13, G L375). 재리뷰 2(review2-codex.md) 원칙으로 다시 세웠다.
--
-- 무엇을 남기나
-- - 보고서가 읽는 모든 표(apps/api/src/reports/tracked.ts TRACKED와 같은 목록)의 행이 바뀔 때마다 행 전체(to_jsonb)를 남긴다.
--   프로젝트 행은 state_log, 프로젝트가 없는 행(설정·실행 PC·전역 알림)은 global_log.
--
-- 언제 「그 시각 전」인가 — 커밋 기준
-- - 문장 실행 시각이 아니라 **커밋(저장 완료) 순서**로 정한다. 쓰기 트랜잭션은 커밋 직전에 커밋 시계(log_clock)를 한 칸 올려
--   그 값을 commit_log에 남긴다(지연 제약 트리거). 시계 행 잠금을 커밋까지 잡으므로 「값 순서 = 커밋 순서」다.
-- - 값은 greatest(직전 값 + 1µs, 지금 시각)이라 PC 시계가 뒤로 가도 줄지 않는다(단조 증가).
-- - 보고서는 먼저 시계를 올린 값(기준점)을 잡고 그 뒤에 읽는다(0037 awbs_report_anchor). 그래서 기준점 T보다 작은 값을 받을
--   커밋은 기준점 전에 모두 끝나 있다 → 「그때 만든 보고서 = 나중에 다시 만든 보고서」.
-- - 왜 track_commit_timestamp가 아닌가: 그 시각은 벽시계라 뒤로 갈 수 있고, 오래된 트랜잭션은 vacuum freeze 때 지워진다.
--
-- 누가 쓰나
-- - 기록은 아래 SECURITY DEFINER 함수만 쓴다. 앱 역할(awbs_app)은 이력 표를 읽기만 한다(쓰기·고치기·지우기·비우기 불가).
-- - 시험 전용 시계 이동(awbs.test_clock_offset)은 관리자(superuser)로 로그인한 연결만 쓸 수 있다. 그 밖에는 거부(42501).
-- 이 표들은 Drizzle 스냅샷 밖의 SQL 전용 표다(권한·트리거 중심, 0015와 같은 방식).
CREATE TABLE public.log_clock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  t timestamp with time zone NOT NULL
);
--> statement-breakpoint
INSERT INTO public.log_clock(t) VALUES ('-infinity');
--> statement-breakpoint
CREATE TABLE public.commit_log (
  xid xid8 PRIMARY KEY,
  committed_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- 실제 커밋 시각(재리뷰 3 문제 1). 커밋 시계 값(commit_log)은 제약 트리거를 일찍 실행하면(SET CONSTRAINTS ALL IMMEDIATE)
-- 실제 커밋보다 먼저 매겨질 수 있다. 그래서 트랜잭션이 **실제로 커밋된 시각**(track_commit_timestamp)을 정리 단계(0037 awbs_settle_commits)가
-- 커밋 뒤에 옮겨 적는다. 보고서는 「커밋 시계 < T 이고 실제 커밋 시각 < T」인 변경만 T 전으로 본다.
-- 옮겨 적는 이유: 실제 커밋 시각은 오래되면 vacuum freeze 때 지워진다.
-- committed_at이 비어 있으면 실제 커밋 시각을 모른다(기록을 끈 동안의 커밋 등). 커밋 시계 값으로 채우지 않는다(지어내지 않는다).
-- 그때 아는 것: 커밋은 stamp(커밋 직전·이전에 매김) 뒤, observed_at(정리가 「커밋됨」을 처음 본 시각) 전에 일어났다.
CREATE TABLE public.commit_real (
  xid xid8 PRIMARY KEY,
  stamp timestamp with time zone NOT NULL,
  committed_at timestamp with time zone,
  observed_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.state_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  seq bigserial NOT NULL,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  project_id uuid,
  tbl text NOT NULL,
  row_id uuid NOT NULL,
  op text NOT NULL,
  data jsonb
);
--> statement-breakpoint
CREATE TABLE public.global_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  seq bigserial NOT NULL,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  tbl text NOT NULL,
  row_id uuid NOT NULL,
  op text NOT NULL,
  data jsonb
);
--> statement-breakpoint
CREATE INDEX state_log_asof ON public.state_log (project_id, tbl, row_id, seq DESC);
CREATE INDEX state_log_xid ON public.state_log (xid);
CREATE INDEX global_log_asof ON public.global_log (tbl, row_id, seq DESC);
CREATE INDEX global_log_xid ON public.global_log (xid);
CREATE INDEX commit_log_at ON public.commit_log (committed_at);
CREATE INDEX commit_real_stamp ON public.commit_real (stamp);
--> statement-breakpoint
DO $$
DECLARE t pg_catalog.text;
BEGIN
  FOREACH t IN ARRAY ARRAY['log_clock','commit_log','commit_real','state_log','global_log'] LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO awbs_data_owner', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM awbs_app', t);
    EXECUTE format('GRANT SELECT ON public.%I TO awbs_app', t);
    EXECUTE format('CREATE TRIGGER guard_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.awbs_delete_guard()', t);
    EXECUTE format('CREATE TRIGGER guard_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.awbs_immutable()', t);
  END LOOP;
  -- 시계 행만 함수가 고친다. 나머지 셋은 추가 전용이다.
  FOREACH t IN ARRAY ARRAY['commit_log','commit_real','state_log','global_log'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.awbs_immutable()', t);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER SEQUENCE public.state_log_seq_seq OWNER TO awbs_data_owner;
ALTER SEQUENCE public.global_log_seq_seq OWNER TO awbs_data_owner;
REVOKE ALL ON SEQUENCE public.state_log_seq_seq, public.global_log_seq_seq FROM awbs_app;
--> statement-breakpoint
-- 시험 전용 시계 이동. 관리자 로그인 연결만 허용한다. 앱 역할 연결이 설정하면 거부한다.
CREATE FUNCTION public.awbs_log_now() RETURNS pg_catalog.timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE shift pg_catalog.text := nullif(pg_catalog.current_setting('awbs.test_clock_offset', true), '');
BEGIN
  IF shift IS NULL THEN RETURN pg_catalog.clock_timestamp(); END IF;
  IF NOT coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user), false) THEN
    RAISE EXCEPTION 'awbs.test_clock_offset is reserved for test fixtures' USING ERRCODE = '42501';
  END IF;
  RETURN pg_catalog.clock_timestamp() + shift::pg_catalog.interval;
END $$;
--> statement-breakpoint
-- 커밋 직전: 이 트랜잭션에 커밋 시계 값을 한 번 매긴다(지연 제약 트리거가 부른다).
CREATE FUNCTION public.awbs_stamp_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me pg_catalog.xid8 := pg_catalog.pg_current_xact_id(); v pg_catalog.timestamptz;
BEGIN
  IF EXISTS (SELECT 1 FROM public.commit_log WHERE xid = me) THEN RETURN NULL; END IF;
  -- 시계 행이 없으면(시험의 전체 비우기 등) 새로 만든다. 행 잠금이 커밋까지 잡혀 「값 순서 = 커밋 순서」다.
  INSERT INTO public.log_clock(singleton, t) VALUES (true, public.awbs_log_now())
  ON CONFLICT (singleton) DO UPDATE SET t = greatest(public.log_clock.t + interval '1 microsecond', EXCLUDED.t) RETURNING t INTO v;
  INSERT INTO public.commit_log(xid, committed_at) VALUES (me, v) ON CONFLICT (xid) DO NOTHING;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER stamp_commit AFTER INSERT ON public.state_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.awbs_stamp_commit();
CREATE CONSTRAINT TRIGGER stamp_commit AFTER INSERT ON public.global_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.awbs_stamp_commit();
--> statement-breakpoint
-- 행 변경 기록. 프로젝트가 있는 행은 state_log, 없는 행은 global_log. 초기화 중의 삭제도 기록한다(건너뛰지 않는다).
CREATE FUNCTION public.awbs_state_log() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r pg_catalog.jsonb; p pg_catalog.uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN r := pg_catalog.to_jsonb(OLD); ELSE r := pg_catalog.to_jsonb(NEW); END IF;
  p := CASE WHEN TG_TABLE_NAME = 'projects' THEN (r->>'id')::uuid ELSE (r->>'project_id')::uuid END;
  IF p IS NULL THEN
    INSERT INTO public.global_log(tbl, row_id, op, data)
    VALUES (TG_TABLE_NAME, (r->>TG_ARGV[0])::uuid, pg_catalog.lower(TG_OP), CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE r END);
  ELSE
    INSERT INTO public.state_log(project_id, tbl, row_id, op, data)
    VALUES (p, TG_TABLE_NAME, (r->>TG_ARGV[0])::uuid, pg_catalog.lower(TG_OP), CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE r END);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DO $$
DECLARE f pg_catalog.text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.awbs_log_now()','public.awbs_stamp_commit()','public.awbs_state_log()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO awbs_data_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
--> statement-breakpoint
-- 기록 대상(apps/api/src/reports/tracked.ts TRACKED와 같아야 한다 — 시험이 대조한다). 이미 있는 행은 「seed」로 한 번 남긴다.
DO $$
DECLARE t pg_catalog.text; k pg_catalog.text;
BEGIN
  FOR t, k IN SELECT * FROM (VALUES
    ('projects','id'),('wbs_nodes','id'),('tasks','id'),('task_specs','task'),('task_dependencies','id'),('checklist_items','id'),
    ('task_outputs','id'),('task_grades','id'),('task_estimates','id'),('task_attempts','id'),('attempt_files','id'),('verifications','id'),
    ('verification_invalidations','id'),('defects','id'),('defect_events','id'),('evidence','id'),('input_versions','id'),('messages','id'),
    ('change_proposals','id'),('ci_runs','id'),('replans','id'),('replan_moves','id'),('schedule_baselines','id'),('baseline_items','id'),
    ('alerts','id'),('runner_sessions','id'),('runner_hosts','id'),('runner_concurrency_log','id'),('agent_usage','id'),
    ('schedule_policy','id'),('blackout_days','id'),('app_settings','id'),('concurrency_settings','id')) v(t,k) LOOP
    EXECUTE format('CREATE TRIGGER state_log AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.awbs_state_log(%L)', t, k);
    EXECUTE format($q$INSERT INTO public.state_log(project_id, tbl, row_id, op, data)
      SELECT p, %L, (pg_catalog.to_jsonb(x)->>%L)::uuid, 'seed', pg_catalog.to_jsonb(x)
      FROM public.%I x CROSS JOIN LATERAL (SELECT CASE WHEN %L = 'projects' THEN (pg_catalog.to_jsonb(x)->>'id')::uuid ELSE (pg_catalog.to_jsonb(x)->>'project_id')::uuid END p) s
      WHERE p IS NOT NULL$q$, t, k, t, t);
    EXECUTE format($q$INSERT INTO public.global_log(tbl, row_id, op, data)
      SELECT %L, (pg_catalog.to_jsonb(x)->>%L)::uuid, 'seed', pg_catalog.to_jsonb(x)
      FROM public.%I x WHERE (CASE WHEN %L = 'projects' THEN (pg_catalog.to_jsonb(x)->>'id')::uuid ELSE (pg_catalog.to_jsonb(x)->>'project_id')::uuid END) IS NULL$q$, t, k, t, t);
  END LOOP;
  -- 기록 시작 표시: 이미 자료가 있던 DB(업그레이드)에서만 남긴다. 이 커밋 시계보다 이른 시점은 이력이 완전하지 않다.
  -- 빈 DB에서 시작하면 표시가 없다 → 처음부터 모든 변경이 기록돼 있다(빈 표도 「그때 비어 있었다」로 정확하다).
  IF EXISTS (SELECT 1 FROM public.state_log) OR EXISTS (SELECT 1 FROM public.global_log) THEN
    INSERT INTO public.global_log(tbl, row_id, op, data) VALUES ('log_start', '00000000-0000-0000-0000-000000000000', 'seed', NULL);
  END IF;
END $$;
