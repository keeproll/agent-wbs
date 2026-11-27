-- M6-01 보고서 상태 이력(0036)의 기준점과 초기화 처리.
--
-- 1. 보고서 기준점(awbs_report_anchor): 보고서를 읽기 **전에** 별도 짧은 트랜잭션에서 정리(awbs_settle_commits)를 하고 커밋 시계를 한 칸 올려 그 값을 돌려준다.
--    - 그 뒤의 모든 커밋은 이 값보다 큰 시계 값을 받는다(시계 행 잠금 순서 = 커밋 순서).
--    - 그래서 「커밋 시계 < 기준점」인 기록은 보고서가 읽기 시작할 때 이미 모두 확정돼 있다. 나중에 같은 기준점으로 다시 읽어도 같은 범위다.
--    - 앱이 불러도 시계를 마음대로 정할 수는 없다(지금 시각과 직전 값 중 큰 쪽).
-- 2. 초기화: 프로젝트 자료는 모두 지우므로 프로젝트 이력(state_log)도 초기화가 끝날 때 지운다(reset_log 기록 시).
--    전역 이력(global_log)은 남긴다. 초기화의 삭제·다시 넣기도 그대로 기록되므로(0036), 설정 유지 여부와 관계없이 그때 값을 되살릴 수 있다.
-- 정리(재리뷰 3 문제 1): 커밋된 트랜잭션의 실제 커밋 시각을 commit_real에 옮겨 적는다.
-- - 시계 행을 먼저 잠근다. 시계 값을 받은 트랜잭션은 커밋할 때까지 그 잠금을 쥐므로, 정리할 때 시계 값을 받은 트랜잭션은 모두 끝나 있다.
--   그래서 「아직 정리하지 않은 것 = 마지막 정리 뒤의 커밋 시계 값」이 빠짐없이 맞다.
-- - 실제 커밋 시각이 없으면(track_commit_timestamp가 꺼져 있던 때) 커밋 시계 값을 쓴다.
-- - 시계를 「정리한 실제 커밋 시각」보다 크게 올려 둔다. PC 시계가 뒤로 가도 기준점이 이미 커밋된 변경보다 앞서지 않게 한다.
CREATE FUNCTION public.awbs_settle_commits() RETURNS pg_catalog.timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v pg_catalog.timestamptz; mark pg_catalog.timestamptz; top pg_catalog.timestamptz;
BEGIN
  INSERT INTO public.log_clock(singleton, t) VALUES (true, '-infinity') ON CONFLICT (singleton) DO NOTHING;
  SELECT t INTO v FROM public.log_clock WHERE singleton FOR UPDATE;
  SELECT max(stamp) INTO mark FROM public.commit_real;
  INSERT INTO public.commit_real(xid, stamp, committed_at)
  SELECT c.xid, c.committed_at,
    coalesce(pg_catalog.pg_xact_commit_timestamp(((c.xid::pg_catalog.text::pg_catalog.int8) % 4294967296)::pg_catalog.text::pg_catalog.xid), c.committed_at)
  FROM public.commit_log c WHERE c.committed_at > coalesce(mark, '-infinity') ON CONFLICT (xid) DO NOTHING;
  SELECT max(committed_at) INTO top FROM public.commit_real WHERE stamp > coalesce(mark, '-infinity');
  IF top IS NOT NULL AND top >= v THEN
    UPDATE public.log_clock SET t = top + interval '1 microsecond' WHERE singleton RETURNING t INTO v;
  END IF;
  RETURN v;
END $$;
--> statement-breakpoint
ALTER FUNCTION public.awbs_settle_commits() OWNER TO awbs_data_owner;
REVOKE ALL ON FUNCTION public.awbs_settle_commits() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.awbs_settle_commits() TO awbs_app;
--> statement-breakpoint
CREATE FUNCTION public.awbs_report_anchor() RETURNS pg_catalog.timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v pg_catalog.timestamptz;
BEGIN
  -- 먼저 정리한다(커밋된 변경의 실제 커밋 시각 확보, 시계는 그보다 크게). 그 다음 한 칸 올린 값이 기준점이다.
  PERFORM public.awbs_settle_commits();
  UPDATE public.log_clock SET t = greatest(t + interval '1 microsecond', public.awbs_log_now()) WHERE singleton RETURNING t INTO v;
  RETURN v;
END $$;
--> statement-breakpoint
ALTER FUNCTION public.awbs_report_anchor() OWNER TO awbs_data_owner;
REVOKE ALL ON FUNCTION public.awbs_report_anchor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.awbs_report_anchor() TO awbs_app;
--> statement-breakpoint
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
