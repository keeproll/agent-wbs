-- JSON null must not bypass proof/code validation through SQL three-valued logic.
-- Commands and their recorded holds are written only by reset_project/complete_cleanup.
REVOKE INSERT, UPDATE ON public.runner_commands FROM awbs_app;
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
        OR jsonb_typeof(proof->'proof') IS DISTINCT FROM 'string' OR proof->>'proof' NOT IN ('no_process','group_empty','boot_changed') OR NOT proof ? 'proof'
        OR (proof->>'proof'='no_process' AND (h->>'pgid' IS NOT NULL OR h->>'cgroup' IS NOT NULL OR h->>'slot_state'='active'))
        OR (proof->>'proof'='group_empty' AND h->>'pgid' IS DISTINCT FROM proof->>'processGroup')
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.awbs_valid_hold_reasons(doc pg_catalog.jsonb) RETURNS pg_catalog.bool
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE item pg_catalog.jsonb;
BEGIN
  IF doc IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(doc)<>'object' OR NOT doc ?& ARRAY['holdReasons','issues']
     OR jsonb_typeof(doc->'holdReasons')<>'array' OR jsonb_typeof(doc->'issues')<>'array'
     OR (doc-ARRAY['holdReasons','issues'])<>'{}'::jsonb THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(doc->'holdReasons') LOOP
    IF jsonb_typeof(item)<>'object' OR NOT item ?& ARRAY['code','message']
       OR jsonb_typeof(item->'code') IS DISTINCT FROM 'string' OR item->>'code' NOT IN ('JUDGEMENT_MISSING','JUDGEMENT_NOT_MET','ORDER_NOT_PRESERVED','ACTIVE_TASK_BLOCKED')
       OR jsonb_typeof(item->'message')<>'string' OR length(btrim(item->>'message'))=0 THEN RETURN false; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(doc->'issues') LOOP
    IF jsonb_typeof(item)<>'object' OR NOT item ?& ARRAY['index','code','message']
       OR (item->'index'<>'null'::jsonb AND (jsonb_typeof(item->'index')<>'number' OR (item->>'index')::numeric<0 OR (item->>'index')::numeric%1<>0))
       OR jsonb_typeof(item->'code')<>'string' OR length(btrim(item->>'code'))=0
       OR jsonb_typeof(item->'message')<>'string' OR length(btrim(item->>'message'))=0 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
