-- M5·M7 통합: Planning 이벤트도 벽시계(created_at·at)가 아니라 수신 순번(record_no)으로 정렬한다(M7-04 결정 7·12, 조정자 추가 범위).
-- 왜: 시계가 뒤로 가면 나중 이벤트가 앞선 이벤트보다 작은 시각을 받는다. 같은 트랜잭션의 now()는 같은 값이라 id(무작위)가 순서를 정하기도 한다.
-- 기존 기록은 지금까지의 정렬(created_at·at, id)을 한 번만 보존한다. 0026과 같은 방식이다.
DO $$ DECLARE t text; ordering text; old_role text := current_setting('session_replication_role'); BEGIN
  PERFORM set_config('session_replication_role','replica',true);
  FOREACH t IN ARRAY ARRAY['change_proposal_events','planning_job_logs','planning_reviews'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN record_no bigserial NOT NULL',t);
    ordering := CASE WHEN t='planning_job_logs' THEN 'at,created_at,id' ELSE 'created_at,id' END;
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
