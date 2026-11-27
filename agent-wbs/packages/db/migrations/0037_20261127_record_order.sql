-- M6 통합 fix2(Codex 리뷰 3차 P2 1~3): 「최신 하나」를 벽시계 대신 뒤로 가지 않는 순번으로 고른다(M5·M7 원칙, M7-04 결정 7·12).
--
-- 1) 옛 M6 통합 DB의 이력 행에 순번을 채운다.
--    무엇이 문제인가: M6 통합 1차 DB(0036~0043 번호)는 상태 이력(state_log·global_log)이 0026·0027보다 먼저 시작됐다.
--    그 뒤 0026·0027이 기록 트리거를 끈 채(session_replication_role=replica) 순번 열을 채웠으므로, 이미 남은 이력 JSON에는 순번이 없다.
--    보고서가 이력에서 행을 되살리면 순번이 null이라 「최신 한 행」을 잘못 고른다(재현: 옛 PC 사양으로 한도 계산).
--    어떻게 채우나: 순번은 행마다 한 번 정해지고 바뀌지 않는다. 그래서 (가) 지금 표의 같은 행, (나) 같은 행의 다른 이력에 있는 값을 쓴다.
--    채울 수 없는 행(순번이 생기기 전에 지워진 행)은 0으로 둔다. 0은 「모든 번호가 붙은 행보다 오래됨」이라는 뜻으로 명시한 값이다.
--    빈 DB와 main DB(0026·0027 → 0028 순서)에는 고칠 행이 없다.
DO $$ DECLARE r record; old_role text := current_setting('session_replication_role'); BEGIN
  PERFORM set_config('session_replication_role','replica',true);
  FOR r IN SELECT * FROM (VALUES
    ('state_log','task_estimates','record_no'),('state_log','task_attempts','record_no'),('state_log','change_proposals','record_no'),('state_log','ci_runs','run_no'),
    ('global_log','runner_sessions','record_no'),('global_log','runner_hosts','record_no'),('global_log','runner_concurrency_log','record_no'),('global_log','agent_usage','record_no')
  ) v(log,tbl,col) LOOP
    EXECUTE format('UPDATE public.%1$I l SET data=jsonb_set(l.data,ARRAY[%3$L],to_jsonb(c.%3$I)) FROM public.%2$I c
      WHERE l.tbl=%2$L AND l.row_id=c.id AND l.data IS NOT NULL AND l.data->>%3$L IS NULL', r.log, r.tbl, r.col);
    EXECUTE format('UPDATE public.%1$I l SET data=jsonb_set(l.data,ARRAY[%3$L],to_jsonb(k.v)) FROM (
        SELECT row_id,max((data->>%3$L)::bigint) v FROM public.%1$I WHERE tbl=%2$L AND data->>%3$L IS NOT NULL GROUP BY row_id) k
      WHERE l.tbl=%2$L AND l.row_id=k.row_id AND l.data IS NOT NULL AND l.data->>%3$L IS NULL', r.log, r.tbl, r.col);
    EXECUTE format('UPDATE public.%1$I l SET data=jsonb_set(l.data,ARRAY[%3$L],to_jsonb(0))
      WHERE l.tbl=%2$L AND l.data IS NOT NULL AND l.data->>%3$L IS NULL', r.log, r.tbl, r.col);
  END LOOP;
  PERFORM set_config('session_replication_role',old_role,true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('session_replication_role',old_role,true);
  RAISE;
END $$;
--> statement-breakpoint
-- 2) M6 자체 표 3개에 저장 순번(record_no)을 더한다. 기존 행은 지금까지의 「최신」 조회와 같은 정렬 순서대로 번호를 매긴다.
--    - notify_outbox: 최근 연결 테스트 선택(설정 켜기의 근거)과 발송 순서.
--    - reports: 메일 테스트 발송의 「최신 보고서」.
--    - design_drifts: 같은 항목의 최신 불일치.
DO $$ DECLARE t text; ordering text; old_role text := current_setting('session_replication_role'); BEGIN
  PERFORM set_config('session_replication_role','replica',true);
  FOREACH t IN ARRAY ARRAY['notify_outbox','reports','design_drifts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN record_no bigserial NOT NULL',t);
    -- reports는 fix2 전 「최신 보고서」 조회와 같은 순서(generated_at → 기간 끝 "to" → id)로 번호를 매긴다(fix3, Codex 리뷰 4차 P2).
    -- 왜: 서버가 꺼진 동안의 정기 보고서는 한 트랜잭션에서 같은 생성 시각·등록 시각으로 함께 만들어진다. 그때 기간 끝이 늦은 보고서가 최신이다.
    --   생성 시각과 기간 끝까지 같으면 id로 정해 늘 같은 결과가 나오게 한다(업그레이드 전후 선택이 같다).
    ordering := CASE WHEN t='reports' THEN 'generated_at,"to",id' ELSE 'created_at,id' END;
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
