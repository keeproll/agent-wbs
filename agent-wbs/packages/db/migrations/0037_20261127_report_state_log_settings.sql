-- M6-01 보고서 상태 이력(0036)의 기준점과 초기화 처리.
--
-- 1. 보고서 기준점(awbs_report_anchor): 보고서를 읽기 **전에** 별도 짧은 트랜잭션에서 커밋 시계를 한 칸 올리고 그 값을 돌려준다.
--    - 그 뒤의 모든 커밋은 이 값보다 큰 시계 값을 받는다(시계 행 잠금 순서 = 커밋 순서).
--    - 그래서 「커밋 시계 < 기준점」인 기록은 보고서가 읽기 시작할 때 이미 모두 확정돼 있다. 나중에 같은 기준점으로 다시 읽어도 같은 범위다.
--    - 앱이 불러도 시계를 마음대로 정할 수는 없다(지금 시각과 직전 값 중 큰 쪽).
-- 2. 초기화: 프로젝트 자료는 모두 지우므로 프로젝트 이력(state_log)도 초기화가 끝날 때 지운다(reset_log 기록 시).
--    전역 이력(global_log)은 남긴다. 초기화의 삭제·다시 넣기도 그대로 기록되므로(0036), 설정 유지 여부와 관계없이 그때 값을 되살릴 수 있다.
CREATE FUNCTION public.awbs_report_anchor() RETURNS pg_catalog.timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v pg_catalog.timestamptz;
BEGIN
  -- 시계 행이 없으면(시험의 전체 비우기 등) 새로 만든다. 행 잠금이 커밋까지 잡혀 「값 순서 = 커밋 순서」다.
  INSERT INTO public.log_clock(singleton, t) VALUES (true, public.awbs_log_now())
  ON CONFLICT (singleton) DO UPDATE SET t = greatest(public.log_clock.t + interval '1 microsecond', EXCLUDED.t) RETURNING t INTO v;
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
