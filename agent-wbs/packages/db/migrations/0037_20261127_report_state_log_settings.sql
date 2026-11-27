-- M6-01 기간 말 재구성 보완(0036 다음).
-- 1. 기록 시각 지정(awbs.state_at)은 DB 관리자(superuser)로 로그인한 연결만 쓸 수 있다. 앱 역할(awbs_app)이 지정하면 거부한다.
--    왜: 앱 역할이 기록 시각을 정할 수 있으면 이력 시각을 위조하는 길이 된다. 시험·데모 준비는 관리자 연결로만 한다.
-- 2. 재조정(replans)의 상태 변경(pending→applied/discarded)도 기록한다. 기간 끝 시점의 재조정 상태를 되살리기 위해서다.
-- 3. 일정 계산이 쓰는 설정 표(일정 정책·작업 불가일·heartbeat·동시 실행 한도)도 기록한다.
--    설정은 프로젝트가 없고 「설정 유지」 초기화 뒤에도 남으므로 별도 표 setting_log에 둔다(프로젝트 자료 표와 수명이 다르다).
-- 4. 초기화: 프로젝트 기록(state_log)은 언제나 지운다. 설정 기록(setting_log)은 「설정까지 삭제」일 때만 지운다(설정도 새로 넣기 때문).
CREATE TABLE public.setting_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  seq bigserial NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  tbl text NOT NULL,
  row_id uuid NOT NULL,
  op text NOT NULL,
  data jsonb
);
--> statement-breakpoint
CREATE INDEX setting_log_asof ON public.setting_log (tbl, row_id, created_at DESC, seq DESC);
--> statement-breakpoint
ALTER TABLE public.setting_log OWNER TO awbs_data_owner;
--> statement-breakpoint
REVOKE ALL ON public.setting_log FROM awbs_app;
GRANT SELECT, INSERT ON public.setting_log TO awbs_app;
GRANT USAGE, SELECT ON SEQUENCE public.setting_log_seq_seq TO awbs_app;
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE ON public.setting_log FOR EACH ROW EXECUTE FUNCTION public.awbs_immutable();
CREATE TRIGGER guard_delete BEFORE DELETE ON public.setting_log FOR EACH ROW EXECUTE FUNCTION public.awbs_delete_guard();
CREATE TRIGGER guard_truncate BEFORE TRUNCATE ON public.setting_log FOR EACH STATEMENT EXECUTE FUNCTION public.awbs_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.awbs_state_log() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE r pg_catalog.jsonb; at pg_catalog.timestamptz; forced pg_catalog.text;
BEGIN
  IF pg_catalog.current_setting('awbs.reset', true) = 'on' THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN r := pg_catalog.to_jsonb(OLD); ELSE r := pg_catalog.to_jsonb(NEW); END IF;
  forced := nullif(pg_catalog.current_setting('awbs.state_at', true), '');
  -- 허용: 로그인한 역할이 관리자(superuser)이고, 지금 역할이 앱 역할(awbs_app)이 아닐 때만. 관리자 연결이 부른 seed_system(SECURITY DEFINER)도 허용된다.
  -- 운영의 앱은 관리자로 로그인하지 않으므로 언제나 거부된다. 시험의 앱 연결(관리자 로그인 + 역할 전환 awbs_app)도 거부된다.
  IF forced IS NOT NULL AND NOT (coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user), false) AND current_user <> 'awbs_app') THEN
    RAISE EXCEPTION 'awbs.state_at is reserved for test fixtures' USING ERRCODE = '42501';
  END IF;
  at := coalesce(forced::pg_catalog.timestamptz, pg_catalog.clock_timestamp());
  IF TG_TABLE_NAME IN ('schedule_policy','blackout_days','app_settings','concurrency_settings') THEN
    INSERT INTO public.setting_log(created_at, tbl, row_id, op, data)
    VALUES (at, TG_TABLE_NAME, (r->>TG_ARGV[0])::uuid, pg_catalog.lower(TG_OP), CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE r END);
    RETURN NULL;
  END IF;
  INSERT INTO public.state_log(created_at, project_id, tbl, row_id, op, data)
  VALUES (at, CASE WHEN TG_TABLE_NAME = 'projects' THEN (r->>'id')::uuid ELSE (r->>'project_id')::uuid END,
    TG_TABLE_NAME, (r->>TG_ARGV[0])::uuid, pg_catalog.lower(TG_OP), CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE r END);
  RETURN NULL;
END $$;
--> statement-breakpoint
DO $$
DECLARE t pg_catalog.text;
BEGIN
  FOREACH t IN ARRAY ARRAY['replans','schedule_policy','blackout_days','app_settings','concurrency_settings'] LOOP
    EXECUTE format('CREATE TRIGGER state_log AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.awbs_state_log(%L)', t, 'id');
    IF t = 'replans' THEN
      INSERT INTO public.state_log(project_id, tbl, row_id, op, data) SELECT x.project_id, 'replans', x.id, 'seed', pg_catalog.to_jsonb(x) FROM public.replans x;
    ELSE
      EXECUTE format($q$INSERT INTO public.setting_log(tbl, row_id, op, data) SELECT %L, x.id, 'seed', pg_catalog.to_jsonb(x) FROM public.%I x$q$, t, t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.awbs_state_log_reset() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM public.state_log;
  IF NOT NEW.keep_settings THEN DELETE FROM public.setting_log; END IF;
  RETURN NULL;
END $$;
