-- 초기화는 공유 잠금을 배타적 잠금으로 바꾸지 않고 처음부터 배타적으로 잠근다.
-- 앱에는 system_state 수정 권한을 주지 않고 잠금 함수만 공개한다.
CREATE FUNCTION public.lock_epoch_exclusive() RETURNS pg_catalog.int4
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE e pg_catalog.int4;
BEGIN
  SELECT epoch INTO STRICT e FROM public.system_state WHERE id=1 FOR UPDATE;
  RETURN e;
END $$;
--> statement-breakpoint
ALTER FUNCTION public.lock_epoch_exclusive() OWNER TO awbs_data_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.lock_epoch_exclusive() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_epoch_exclusive() TO awbs_app;
--> statement-breakpoint
-- 생존 보고와 정리 명령 조회는 옛 세대도 받는다. 기다리는 동안 초기화되어도 최신 세대를 돌려준다.
CREATE FUNCTION public.lock_current_epoch() RETURNS pg_catalog.int4
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE e pg_catalog.int4;
BEGIN
  SELECT epoch INTO STRICT e FROM public.system_state WHERE id=1 FOR SHARE;
  RETURN e;
END $$;
--> statement-breakpoint
ALTER FUNCTION public.lock_current_epoch() OWNER TO awbs_data_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.lock_current_epoch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_current_epoch() TO awbs_app;
