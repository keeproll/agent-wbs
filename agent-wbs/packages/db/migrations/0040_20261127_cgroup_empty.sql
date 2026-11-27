-- M8 전 연결(조정자 결정 3): 해제 증거 「cgroup_empty」를 더한다.
--
-- 무엇이 바뀌나
-- - Runner는 전용 계정(Q-08) 세션을 사용자 cgroup scope 안에서 실행하고, /process에 그 cgroup 경로를 보고한다.
-- - cgroup이 기록된 보유는 group_empty(프로세스 그룹이 빔)로 닫지 않는다. cgroup_empty(그 cgroup의 cgroup.events populated=0 확인)로만 닫는다.
--   왜: 프로세스 그룹은 setsid·이중 fork로 빠져나간 Agent 자손을 증명하지 못한다. cgroup은 계정과 상관없이 자손이 빠져나가지 못한다.
-- - cgroup이 없는 보유는 지금처럼 group_empty·no_process로 닫는다. boot_changed는 둘 다 쓸 수 있다(부팅이 바뀌면 모든 프로세스가 없다).
-- - 초기화 정리(complete_cleanup)도 같은 규칙으로 보유별 증거를 확인한다.
ALTER TYPE public.release_proof ADD VALUE IF NOT EXISTS 'cgroup_empty';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.awbs_hold_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.slot_state NOT IN ('none','reserved') OR NEW.lock_state NOT IN ('none','held')
       OR NEW.release_proof IS NOT NULL OR NEW.pgid IS NOT NULL OR NEW.cgroup IS NOT NULL
       OR (NEW.slot_state='none' AND NEW.lock_state='held' AND NEW.lock_from_job IS NULL)
       OR (NEW.slot_state='reserved' AND (NEW.host_id IS NULL OR NEW.boot_id IS NULL OR NEW.fence IS NULL))
       OR NEW.handed_to_job IS NOT NULL THEN
      RAISE EXCEPTION 'hold must start at claim or handover' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.closed_at IS NOT NULL THEN RAISE EXCEPTION 'closed hold is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.job<>OLD.job OR NEW.epoch<>OLD.epoch OR NEW.task IS DISTINCT FROM OLD.task
     OR NEW.conflict_group IS DISTINCT FROM OLD.conflict_group OR NEW.agent<>OLD.agent
     OR NEW.lock_from_job IS DISTINCT FROM OLD.lock_from_job
     OR (OLD.attempt IS NOT NULL AND NEW.attempt IS DISTINCT FROM OLD.attempt) THEN
    RAISE EXCEPTION 'hold identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.fence IS NOT NULL AND (NEW.fence IS NULL OR NEW.fence<OLD.fence) THEN
    RAISE EXCEPTION 'hold fence cannot decrease' USING ERRCODE='23514';
  END IF;
  IF NOT (OLD.slot_state='none' AND NEW.slot_state='reserved') AND
     (NEW.host_id IS DISTINCT FROM OLD.host_id OR NEW.boot_id IS DISTINCT FROM OLD.boot_id OR NEW.fence IS DISTINCT FROM OLD.fence) THEN
    RAISE EXCEPTION 'hold binding changes only on reservation' USING ERRCODE='23514';
  END IF;
  IF NEW.slot_state<>OLD.slot_state AND NOT (
    (OLD.slot_state='none' AND NEW.slot_state='reserved') OR
    (OLD.slot_state='reserved' AND NEW.slot_state IN ('active','none','unconfirmed')) OR
    (OLD.slot_state='active' AND NEW.slot_state IN ('none','unconfirmed')) OR
    (OLD.slot_state='unconfirmed' AND NEW.slot_state='none')) THEN
    RAISE EXCEPTION 'invalid slot transition' USING ERRCODE='23514';
  END IF;
  IF OLD.slot_state='none' AND NEW.slot_state='reserved' THEN
    IF NEW.host_id IS NULL OR NEW.boot_id IS NULL OR NEW.fence IS NULL THEN RAISE EXCEPTION 'reservation binding required' USING ERRCODE='23514'; END IF;
    NEW.release_proof:=NULL; NEW.pgid:=NULL; NEW.cgroup:=NULL;
  ELSIF NEW.slot_state='none' AND OLD.slot_state<>'none' THEN
    IF NEW.release_proof IS NULL OR (NEW.release_proof='no_process' AND
      (OLD.slot_state='active' OR OLD.pgid IS NOT NULL OR OLD.cgroup IS NOT NULL))
      -- 0040: cgroup이 기록된 보유는 cgroup_empty(또는 부팅 변경)로만, cgroup이 없는 보유는 group_empty로만 닫는다.
      OR (NEW.release_proof::text='group_empty' AND OLD.cgroup IS NOT NULL)
      OR (NEW.release_proof::text='cgroup_empty' AND (OLD.cgroup IS NULL OR OLD.pgid IS NULL)) THEN
      RAISE EXCEPTION 'fresh, compatible release proof required' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.release_proof IS DISTINCT FROM OLD.release_proof THEN
    RAISE EXCEPTION 'proof is only recorded on release' USING ERRCODE='23514';
  END IF;
  IF NOT ((OLD.slot_state='reserved' AND NEW.slot_state='active') OR (OLD.slot_state='none' AND NEW.slot_state='reserved'))
     AND (NEW.pgid IS DISTINCT FROM OLD.pgid OR NEW.cgroup IS DISTINCT FROM OLD.cgroup) THEN
    RAISE EXCEPTION 'process group is only recorded by /process' USING ERRCODE='23514';
  END IF;
  IF NEW.lock_state<>OLD.lock_state AND NOT (
    (OLD.lock_state='none' AND NEW.lock_state='held') OR
    (OLD.lock_state='held' AND NEW.lock_state IN ('handed_over','released','orphaned'))) THEN
    RAISE EXCEPTION 'invalid lock transition' USING ERRCODE='23514';
  END IF;
  IF NEW.handed_to_job IS DISTINCT FROM OLD.handed_to_job AND NOT (OLD.lock_state='held' AND NEW.lock_state='handed_over') THEN
    RAISE EXCEPTION 'handover target changes only during handover' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.complete_cleanup(command_id pg_catalog.uuid,command_epoch pg_catalog.int4,succeeded pg_catalog.bool,result pg_catalog.jsonb)
RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE e pg_catalog.int4; cmd public.runner_commands%ROWTYPE; h pg_catalog.jsonb; proof pg_catalog.jsonb;
BEGIN
  SELECT epoch INTO STRICT e FROM public.system_state WHERE id=1 FOR UPDATE;
  SELECT * INTO cmd FROM public.runner_commands WHERE id=command_id FOR UPDATE;
  IF NOT FOUND OR cmd.kind<>'reset-cleanup' THEN RAISE EXCEPTION 'cleanup command not found' USING ERRCODE='P0002'; END IF;
  IF command_epoch IS DISTINCT FROM cmd.epoch OR command_epoch>=e THEN RAISE EXCEPTION 'EPOCH_MISMATCH' USING ERRCODE='AW001'; END IF;
  IF succeeded IS NULL OR jsonb_typeof(result) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'cleanup result required' USING ERRCODE='22023'; END IF;
  IF cmd.status='done' THEN RETURN; END IF;
  IF succeeded THEN
    IF jsonb_typeof(result->'holds') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'hold cleanup proofs required' USING ERRCODE='AW002'; END IF;
    FOR h IN SELECT value FROM jsonb_array_elements(cmd.payload->'holds') LOOP
      SELECT value INTO proof FROM jsonb_array_elements(result->'holds') WHERE value->>'job'=h->>'job';
      IF proof IS NULL OR proof->>'hostId' IS DISTINCT FROM h->>'host_id'
        OR proof->>'bootId' IS DISTINCT FROM h->>'boot_id'
        OR jsonb_typeof(proof->'proof') IS DISTINCT FROM 'string' OR proof->>'proof' NOT IN ('no_process','group_empty','cgroup_empty','boot_changed') OR NOT proof ? 'proof'
        OR (proof->>'proof'='no_process' AND (h->>'pgid' IS NOT NULL OR h->>'cgroup' IS NOT NULL OR h->>'slot_state'='active'))
        OR (proof->>'proof'='group_empty' AND (h->>'pgid' IS DISTINCT FROM proof->>'processGroup' OR h->>'cgroup' IS NOT NULL))
        -- 0040: cgroup이 기록된 보유는 같은 cgroup 경로와 그룹 번호의 cgroup_empty로만 정리를 확인한다.
        OR (proof->>'proof'='cgroup_empty' AND (h->>'cgroup' IS NULL OR h->>'cgroup' IS DISTINCT FROM proof->>'cgroup'
          OR h->>'pgid' IS DISTINCT FROM proof->>'processGroup'))
        OR (proof->>'proof'='boot_changed' AND (proof->>'currentBootId' IS NULL OR proof->>'currentBootId'=h->>'boot_id')) THEN
        RAISE EXCEPTION 'recorded process cleanup is not confirmed' USING ERRCODE='AW002';
      END IF;
    END LOOP;
  END IF;
  UPDATE public.runner_commands SET status=CASE WHEN succeeded THEN 'done' ELSE 'failed' END,
    result=complete_cleanup.result,attempts=attempts+1 WHERE id=command_id;
  UPDATE public.reset_log SET runner_cleanup_status=CASE WHEN succeeded THEN 'done' ELSE 'failed' END,
    finished_at=CASE WHEN succeeded THEN clock_timestamp() ELSE NULL END WHERE epoch=command_epoch+1;
  UPDATE public.system_state SET cleanup_status=CASE
    WHEN EXISTS(SELECT FROM public.runner_commands WHERE status='failed') THEN 'failed'::public.cleanup_status
    WHEN EXISTS(SELECT FROM public.runner_commands WHERE status<>'done') THEN 'pending'::public.cleanup_status
    ELSE 'none'::public.cleanup_status END WHERE id=1;
END $$;
