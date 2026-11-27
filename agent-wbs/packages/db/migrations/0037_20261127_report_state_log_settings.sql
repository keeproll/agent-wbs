-- M6-01 기간 말 재구성 보완(0036 다음).
-- 1. 기록 시각 지정(awbs.state_at)은 DB 관리자(superuser)로 로그인한 연결만 쓸 수 있다. 앱 역할(awbs_app)이 지정하면 거부한다.
--    왜: 앱 역할이 기록 시각을 정할 수 있으면 이력 시각을 위조하는 길이 된다. 시험·데모 준비는 관리자 연결로만 한다.
-- 2. 재조정(replans)의 상태 변경(pending→applied/discarded)도 기록한다. 기간 끝 시점의 재조정 상태를 되살리기 위해서다.
-- 3. 일정 계산이 쓰는 설정 표(일정 정책·작업 불가일·heartbeat·동시 실행 한도)도 기록한다. 설정은 프로젝트가 없다(project_id 없음).
-- 4. 초기화: 설정 유지면 프로젝트 기록만 지우고 설정 기록은 남긴다. 설정까지 지우면 모두 지운다(설정도 새로 넣기 때문).
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
    EXECUTE format($q$INSERT INTO public.state_log(project_id, tbl, row_id, op, data)
      SELECT %s, %L, x.id, 'seed', pg_catalog.to_jsonb(x) FROM public.%I x$q$,
      CASE WHEN t = 'replans' THEN 'x.project_id' ELSE 'null::uuid' END, t, t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.awbs_state_log_reset() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.keep_settings THEN
    DELETE FROM public.state_log WHERE project_id IS NOT NULL;
  ELSE
    DELETE FROM public.state_log;
  END IF;
  RETURN NULL;
END $$;
