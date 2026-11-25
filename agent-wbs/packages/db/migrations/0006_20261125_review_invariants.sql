-- Custom SQL migration file, put your code below! --
CREATE OR REPLACE FUNCTION public.awbs_delete_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN
    IF current_setting('awbs.reset',true)='on' THEN RETURN OLD; END IF;
    IF TG_TABLE_NAME='change_events' AND current_setting('awbs.retention',true)='on'
       AND OLD.at<statement_timestamp()-interval '7 days' THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'physical deletion requires a permitted operation' USING ERRCODE='42501';
END $$;
--> statement-breakpoint
-- DELETE /api/dependencies/:id; POST/DELETE checklist; section replacement via PATCH
-- spec/design/outputs; DELETE grade; PUT /settings/{blackouts,models,subagents};
-- DELETE mail recipients; logout/token revocation/secret rotation; successful file-delete worker.
DO $$
DECLARE t pg_catalog.text;
BEGIN
  FOREACH t IN ARRAY ARRAY['task_dependencies','checklist_items','task_specs','task_designs','task_outputs','task_grades','task_subagents','task_design_items','task_source_links','mail_recipients','blackout_days','lead_sessions','lead_login_tokens','lead_credentials','runner_tokens','secrets','file_delete_queue'] LOOP
    EXECUTE format('GRANT DELETE ON public.%I TO awbs_app',t);
    EXECUTE format('DROP TRIGGER guard_delete ON public.%I',t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.prune_change_events() RETURNS pg_catalog.int4
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE n pg_catalog.int4; previous pg_catalog.text;
BEGIN
  previous:=current_setting('awbs.retention',true);
  PERFORM set_config('awbs.retention','on',true);
  DELETE FROM public.change_events WHERE at<statement_timestamp()-interval '7 days';
  GET DIAGNOSTICS n=ROW_COUNT;
  PERFORM set_config('awbs.retention',coalesce(previous,''),true);
  RETURN n;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.lock_epoch(expected_epoch pg_catalog.int4) RETURNS pg_catalog.int4
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE e pg_catalog.int4;
BEGIN
  SELECT epoch INTO STRICT e FROM public.system_state WHERE id=1 FOR SHARE;
  IF e IS DISTINCT FROM expected_epoch THEN RAISE EXCEPTION 'EPOCH_MISMATCH' USING ERRCODE='AW001'; END IF;
  RETURN e;
END $$;
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
      (OLD.slot_state='active' OR OLD.pgid IS NOT NULL OR OLD.cgroup IS NOT NULL)) THEN
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
DROP TRIGGER hold_transition ON public.execution_holds;
CREATE TRIGGER hold_transition BEFORE INSERT OR UPDATE ON public.execution_holds FOR EACH ROW EXECUTE FUNCTION public.awbs_hold_transition();
--> statement-breakpoint
CREATE FUNCTION public.awbs_handover() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.execution_holds%ROWTYPE; b public.execution_holds%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.execution_holds WHERE id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF a.lock_state='handed_over' THEN
    SELECT * INTO b FROM public.execution_holds WHERE job=a.handed_to_job;
    IF NOT FOUND OR b.lock_from_job IS DISTINCT FROM a.job OR b.epoch<>a.epoch OR b.project_id IS DISTINCT FROM a.project_id OR b.task IS DISTINCT FROM a.task
      OR b.conflict_group IS DISTINCT FROM a.conflict_group THEN
      RAISE EXCEPTION 'handover requires reciprocal receiving hold' USING ERRCODE='23514';
    END IF;
  END IF;
  IF a.lock_from_job IS NOT NULL THEN
    SELECT * INTO b FROM public.execution_holds WHERE job=a.lock_from_job;
    IF NOT FOUND OR b.lock_state<>'handed_over' OR b.handed_to_job IS DISTINCT FROM a.job OR b.epoch<>a.epoch OR b.project_id IS DISTINCT FROM a.project_id
       OR b.task IS DISTINCT FROM a.task OR b.conflict_group IS DISTINCT FROM a.conflict_group THEN
      RAISE EXCEPTION 'receiving hold requires reciprocal handover' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER hold_handover AFTER INSERT OR UPDATE ON public.execution_holds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.awbs_handover();
--> statement-breakpoint
CREATE FUNCTION public.awbs_job_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.fence<OLD.fence OR NEW.epoch<>OLD.epoch OR NEW.dedup_key IS DISTINCT FROM OLD.dedup_key OR
    (OLD.state IN ('done','failed','cancelled') AND (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at')) THEN
    RAISE EXCEPTION 'job fence and terminal state are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_update BEFORE UPDATE ON public.runner_jobs FOR EACH ROW EXECUTE FUNCTION public.awbs_job_update();
--> statement-breakpoint
CREATE FUNCTION public.awbs_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.generation<1 OR (TG_OP='UPDATE' AND (NEW.generation<OLD.generation OR
      (NEW.host_id<>OLD.host_id AND NEW.generation<=OLD.generation) OR
      (OLD.state='blocked' AND NEW.state='granted' AND NEW.reconciled_at IS NULL))) THEN
    RAISE EXCEPTION 'external authority requires monotone generation and reconciliation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authority_generation BEFORE INSERT OR UPDATE ON public.external_write_authority FOR EACH ROW EXECUTE FUNCTION public.awbs_generation();
DROP TRIGGER guard_delete ON public.external_write_authority;
CREATE TRIGGER authority_no_delete BEFORE DELETE ON public.external_write_authority FOR EACH ROW EXECUTE FUNCTION public.awbs_immutable();
--> statement-breakpoint
CREATE FUNCTION public.awbs_replan_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF OLD.status<>'pending' OR NEW.status NOT IN ('applied','discarded') OR
    (to_jsonb(NEW)-ARRAY['status','baseline_v','after','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','baseline_v','after','updated_at']) THEN
    RAISE EXCEPTION 'pending replan can be finalized exactly once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER append_only ON public.replans;
CREATE TRIGGER replan_transition BEFORE UPDATE ON public.replans FOR EACH ROW EXECUTE FUNCTION public.awbs_replan_transition();
GRANT UPDATE(status,baseline_v,after) ON public.replans TO awbs_app;
--> statement-breakpoint
CREATE FUNCTION public.awbs_counter() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.value<OLD.value OR NEW.project_id<>OLD.project_id OR NEW.kind<>OLD.kind THEN
    RAISE EXCEPTION 'allocated numbers cannot be reused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER counter_monotone BEFORE UPDATE ON public.counters FOR EACH ROW EXECUTE FUNCTION public.awbs_counter();
--> statement-breakpoint
CREATE FUNCTION public.awbs_tree() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE parent_kind public.node_kind; parent_project pg_catalog.uuid;
BEGIN
  IF TG_TABLE_NAME='tasks' THEN
    SELECT kind,project_id INTO parent_kind,parent_project FROM public.wbs_nodes WHERE id=NEW.wbs_node_id FOR SHARE;
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF parent_kind IS DISTINCT FROM 'work_package'::public.node_kind OR parent_project IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'Task parent must be its Work Package' USING ERRCODE='23514';
    END IF;
  ELSE
    IF TG_OP='UPDATE' AND (NEW.kind<>OLD.kind OR NEW.project_id<>OLD.project_id) THEN
      RAISE EXCEPTION 'WBS node kind and project are immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.parent_id IS NOT NULL THEN
      SELECT kind,project_id INTO parent_kind,parent_project FROM public.wbs_nodes WHERE id=NEW.parent_id FOR SHARE;
      IF NOT FOUND THEN RETURN NEW; END IF;
      IF parent_kind IS DISTINCT FROM 'phase'::public.node_kind OR parent_project IS DISTINCT FROM NEW.project_id THEN
        RAISE EXCEPTION 'Work Package parent must be its Phase' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_parent BEFORE INSERT OR UPDATE OF wbs_node_id,project_id ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.awbs_tree();
CREATE TRIGGER wbs_parent BEFORE INSERT OR UPDATE OF parent_id,kind,project_id ON public.wbs_nodes FOR EACH ROW EXECUTE FUNCTION public.awbs_tree();

--> statement-breakpoint

-- Canonical approved defaults: G §5.2-1/7.3/4.14/4.13/§3 and owner Q-03/Q-04/Q-06.
-- Both seedSystem and reset(false) invoke this function; no second copy in TypeScript.
CREATE FUNCTION public.seed_system() RETURNS pg_catalog.void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE cli pg_catalog.text; models pg_catalog.text[]; model pg_catalog.text; effort pg_catalog.text; level pg_catalog.int4;
BEGIN
  INSERT INTO public.system_state(id) VALUES(1) ON CONFLICT DO NOTHING;
  PERFORM epoch FROM public.system_state WHERE id=1 FOR SHARE;
  INSERT INTO public.app_settings(singleton,heartbeat_seconds,heartbeat_misses,split,stage_pct,timezone)
    VALUES(true,60,3,'{"maxH":4,"minH":0.5,"maxFiles":8,"testIn":true,"dir":"layer","on":{"one":true,"domain":true,"size":true,"verify":true,"revert":true,"cg":true,"contract":true,"irrev":true,"refactor":true,"unknown":true}}'::pg_catalog.jsonb,'{"planning":0,"approval":0,"ready":0,"failed":20,"running":35,"paused":40,"rework":50,"qa":65,"verifying":80,"gate":90,"done":100,"cancelled":0}'::pg_catalog.jsonb,'Asia/Seoul') ON CONFLICT DO NOTHING;
  INSERT INTO public.exec_policy(singleton,on_usage,on_rework,esc_notify,floors,live_inject,auto_retry_limit,auto_rework_limit)
    VALUES(true,'wait','up1',2,'{"verifyGeDev":true,"dbHigh":true}',false,2,3) ON CONFLICT DO NOTHING;
  -- G §3 fixes cp_auto=true; auto_replan has no explicit confirmed default in G.
  INSERT INTO public.schedule_policy(singleton,window_days,min_hours,cp_auto) VALUES(true,7,72,true) ON CONFLICT DO NOTHING;
  INSERT INTO public.ci_settings(singleton,night_at,retry) VALUES(true,'02:00',1) ON CONFLICT DO NOTHING;
  INSERT INTO public.notify_settings(singleton,enabled) VALUES(true,false) ON CONFLICT DO NOTHING;
  INSERT INTO public.notify_rules(key,enabled) VALUES ('done',false),('fail',true),('admin',true),('approve',true),('buildOk',false),('buildFail',true) ON CONFLICT DO NOTHING;
  FOR cli,models IN SELECT * FROM (VALUES ('Codex',ARRAY['gpt-6.2-sol','gpt-6.2-astra','gpt-6.1-sol','gpt-6.1-terra','gpt-6-sol','gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-6-luna','gpt-5.6-luna','gpt-5.5']::pg_catalog.text[]),('Claude',ARRAY['claude-fable-5-2','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5']::pg_catalog.text[])) approved LOOP
    FOREACH model IN ARRAY models LOOP
      level:=0;
      FOREACH effort IN ARRAY ARRAY['low','medium','high','xhigh','max'] LOOP
        level:=level+1;
        IF model='gpt-5.5' AND effort='max' THEN CONTINUE; END IF;
        INSERT INTO public.agent_efforts(agent,model_id,value,common_level,supported,confirmation)
          VALUES(cli::public.agent,model,effort,level,
            CASE WHEN cli='Claude' OR model='gpt-5.5' THEN NULL ELSE true END,
            CASE WHEN cli='Claude' THEN 'bundled-api-docs; cli-per-model-unconfirmed'
                 WHEN model='gpt-5.5' THEN 'bundled-only; availability-unconfirmed'
                 ELSE 'bundled-and-local-cache' END) ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.reset_project(expected_epoch pg_catalog.int4, confirm_name pg_catalog.text, keep_settings pg_catalog.bool, reset_actor pg_catalog.text)
RETURNS pg_catalog.int4 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,pg_temp AS $$
DECLARE current_epoch pg_catalog.int4; p public.projects%ROWTYPE; deleted_count pg_catalog.int4; holds pg_catalog.jsonb; branches pg_catalog.jsonb; prs pg_catalog.jsonb; t pg_catalog.text; generation pg_catalog.int4;
BEGIN
  SELECT epoch INTO STRICT current_epoch FROM public.system_state WHERE id=1 FOR UPDATE;
  IF expected_epoch IS DISTINCT FROM current_epoch THEN RAISE EXCEPTION 'EPOCH_MISMATCH' USING ERRCODE='AW001'; END IF;
  SELECT * INTO p FROM public.projects FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF confirm_name IS DISTINCT FROM p.name THEN RAISE EXCEPTION 'confirmName mismatch' USING ERRCODE='22023'; END IF;
  IF keep_settings IS NULL OR reset_actor IS NULL OR reset_actor='' THEN RAISE EXCEPTION 'reset arguments required' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO deleted_count FROM public.tasks;
  SELECT coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) INTO holds FROM public.execution_holds h WHERE slot_state<>'none' OR lock_state='held';
  SELECT coalesce(jsonb_agg(branch ORDER BY branch), '[]'::jsonb) INTO branches FROM (
    SELECT branch FROM public.task_attempts UNION SELECT ref FROM public.ci_runs
    UNION SELECT ref FROM public.design_snapshots UNION SELECT payload->>'branch' FROM public.runner_jobs
    UNION SELECT payload->>'ref' FROM public.runner_jobs
    UNION SELECT jsonb_array_elements_text(payload->'branches') FROM public.runner_commands WHERE jsonb_typeof(payload->'branches')='array'
  ) refs WHERE branch LIKE 'agent/%';
  SELECT coalesce(jsonb_agg(pr ORDER BY pr), '[]'::jsonb) INTO prs FROM (
    SELECT pr FROM public.task_attempts UNION SELECT pr FROM public.ci_runs UNION SELECT pr FROM public.merge_queue
    UNION SELECT (payload->>'pr')::int FROM public.runner_jobs WHERE payload->>'pr' ~ '^[1-9][0-9]*$'
    UNION SELECT v::int FROM public.runner_commands, LATERAL jsonb_array_elements_text(payload->'prs') v WHERE jsonb_typeof(payload->'prs')='array'
  ) refs WHERE pr IS NOT NULL;
  SELECT a.generation INTO generation FROM public.external_write_authority a;
  INSERT INTO public.file_delete_queue(epoch,path,reason) VALUES(current_epoch,current_epoch::text || '/', 'project-reset');
  INSERT INTO public.runner_commands(kind,epoch,payload,status) VALUES('reset-cleanup',current_epoch,
    jsonb_build_object('epochPath',current_epoch::text || '/', 'holds',holds,'generation',generation) ||
    CASE WHEN p.base_commit IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('repoUrl',p.repo_url,'baseCommit',p.base_commit,'branches',branches,'prs',prs) END, 'pending');
  PERFORM set_config('awbs.reset','on',true);
  DELETE FROM public.defect_events;
  DELETE FROM public.verification_invalidations;
  DELETE FROM public.merge_queue;
  DELETE FROM public.evidence;
  DELETE FROM public.defects;
  DELETE FROM public.ci_steps;
  DELETE FROM public.verifications;
  DELETE FROM public.task_outputs;
  DELETE FROM public.messages;
  DELETE FROM public.execution_holds;
  DELETE FROM public.design_edges;
  DELETE FROM public.ci_runs;
  DELETE FROM public.attempt_subagents;
  DELETE FROM public.attempt_observations;
  DELETE FROM public.attempt_files;
  DELETE FROM public.task_subagents;
  DELETE FROM public.task_splits;
  DELETE FROM public.task_specs;
  DELETE FROM public.task_source_links;
  DELETE FROM public.task_history;
  DELETE FROM public.task_grades;
  DELETE FROM public.task_estimates;
  DELETE FROM public.task_designs;
  DELETE FROM public.task_design_items;
  DELETE FROM public.task_dependencies;
  DELETE FROM public.task_attempts;
  DELETE FROM public.replan_moves;
  DELETE FROM public.flaky_tests;
  DELETE FROM public.design_ownership;
  DELETE FROM public.design_items;
  DELETE FROM public.checklist_items;
  DELETE FROM public.baseline_items;
  DELETE FROM public.wbs_drafts;
  DELETE FROM public.tech_decision_events;
  DELETE FROM public.tasks;
  DELETE FROM public.runner_job_events;
  DELETE FROM public.report_pdfs;
  DELETE FROM public.planning_reviews;
  DELETE FROM public.planning_job_steps;
  DELETE FROM public.planning_job_logs;
  DELETE FROM public.planning_analyses;
  DELETE FROM public.notify_outbox;
  DELETE FROM public.mail_outbox;
  DELETE FROM public.mail_log;
  DELETE FROM public.input_change_commits;
  DELETE FROM public.design_versions;
  DELETE FROM public.design_files;
  DELETE FROM public.change_proposal_events;
  DELETE FROM public.wbs_nodes;
  DELETE FROM public.tech_decisions;
  DELETE FROM public.tech_constraints;
  DELETE FROM public.schedule_baselines;
  DELETE FROM public.runner_jobs;
  DELETE FROM public.reports;
  DELETE FROM public.repo_checks;
  DELETE FROM public.replans;
  DELETE FROM public.plannings;
  DELETE FROM public.planning_jobs;
  DELETE FROM public.notify_log;
  DELETE FROM public.notify_events;
  DELETE FROM public.input_version_results;
  DELETE FROM public.input_versions;
  DELETE FROM public.idempotency_keys;
  DELETE FROM public.design_snapshots;
  DELETE FROM public.design_drifts;
  DELETE FROM public.counters;
  DELETE FROM public.change_proposals;
  DELETE FROM public.change_events;
  DELETE FROM public.alerts;
  DELETE FROM public.projects;
  IF NOT keep_settings THEN
    FOREACH t IN ARRAY ARRAY['mail_recipients','mail_settings','notify_rules','notify_settings','app_settings','ci_settings','blackout_days','schedule_policy','cli_observation_grades','exec_policy','concurrency_settings','runner_readiness','runner_concurrency_log','runner_hosts','runner_sessions','agent_usage','agent_models'] LOOP
      EXECUTE format('DELETE FROM public.%I', t);
    END LOOP;
    DELETE FROM public.subagent_defs WHERE is_demo;
    PERFORM public.seed_system();
    DELETE FROM public.secrets WHERE key IS DISTINCT FROM (SELECT secret_key FROM public.github_settings);
  END IF;
  UPDATE public.system_state SET epoch=current_epoch+1, cleanup_status='pending' WHERE id=1;
  INSERT INTO public.reset_log(epoch,actor,deleted_task_count,keep_settings,runner_cleanup_status) VALUES(current_epoch+1,reset_actor,deleted_count,keep_settings,'pending');
  PERFORM set_config('awbs.reset','off',true);
  RETURN current_epoch+1;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.complete_cleanup(command_id pg_catalog.uuid,command_epoch pg_catalog.int4,succeeded pg_catalog.bool,result pg_catalog.jsonb)
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
        OR proof->>'proof' NOT IN ('no_process','group_empty','boot_changed') OR NOT proof ? 'proof'
        OR (proof->>'proof'='no_process' AND (h->>'pgid' IS NOT NULL OR h->>'slot_state'='active'))
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
CREATE FUNCTION public.awbs_reset_log_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['runner_cleanup_status','finished_at','updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['runner_cleanup_status','finished_at','updated_at']) THEN
    RAISE EXCEPTION 'reset audit identity is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reset_audit_update BEFORE UPDATE ON public.reset_log FOR EACH ROW EXECUTE FUNCTION public.awbs_reset_log_update();
--> statement-breakpoint
-- Add scope coverage for the new result relation before removing redundant scalar FKs.
ALTER TABLE public.input_version_results ADD UNIQUE(project_id,id);
ALTER TABLE public.input_version_results ADD CONSTRAINT scope_input_version_results_input_version
  FOREIGN KEY(project_id,input_version) REFERENCES public.input_versions(project_id,id) ON DELETE RESTRICT;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.conrelid::regclass AS child,c.conname FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='project_id' AND a.attnotnull
    WHERE c.contype='f' AND cardinality(c.conkey)=1 AND c.conkey[1]<>a.attnum
      AND EXISTS(SELECT FROM pg_constraint s WHERE s.contype='f' AND s.conrelid=c.conrelid AND s.confrelid=c.confrelid
        AND cardinality(s.conkey)=2 AND s.conkey @> c.conkey AND a.attnum=ANY(s.conkey)) LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.child,r.conname);
  END LOOP;
  FOR r IN SELECT c.conrelid::regclass AS child,c.conname,
      (SELECT string_agg(quote_ident(a.attname),',' ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(num,ordinality)
       JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num) AS columns
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE c.contype='f' AND n.nspname='public' AND NOT EXISTS(SELECT FROM pg_index i WHERE i.indrelid=c.conrelid
      AND i.indisvalid AND i.indpred IS NULL AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1]=c.conkey) LOOP
    EXECUTE format('CREATE INDEX %I ON %s(%s)','fk_'||md5(r.conname),r.child,r.columns);
  END LOOP;
END $$;
CREATE INDEX history_task_time ON public.task_history(task,at DESC);
CREATE INDEX jobs_ready ON public.runner_jobs(state,lease_until) WHERE state IN ('queued','leased','reconcile');
--> statement-breakpoint
-- Nullable global references must still agree with the referenced row's scope.
CREATE FUNCTION public.awbs_global_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE ref pg_catalog.uuid; parent_project pg_catalog.uuid;
BEGIN
  ref:=(to_jsonb(NEW)->>TG_ARGV[1])::uuid;
  IF ref IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT project_id FROM public.%I WHERE id=$1',TG_ARGV[0]) INTO parent_project USING ref;
  IF parent_project IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'reference scope mismatch' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.conrelid::regclass AS child,c.conname,a.attname AS col,p.relname AS parent
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
    JOIN pg_class p ON p.oid=c.confrelid
    WHERE c.contype='f' AND cardinality(c.conkey)=1 AND a.attname<>'project_id'
      AND EXISTS(SELECT FROM pg_attribute WHERE attrelid=c.conrelid AND attname='project_id' AND NOT attnotnull)
      AND EXISTS(SELECT FROM pg_attribute WHERE attrelid=c.confrelid AND attname='project_id') LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION public.awbs_global_scope(%L,%L)',
      'global_'||md5(r.conname),r.child,r.parent,r.col);
  END LOOP;
END $$;
--> statement-breakpoint
-- Every future table must pass the catalog policy regression test as well.
DO $$
DECLARE r record; t pg_catalog.text;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO awbs_data_owner',r.tablename);
    EXECUTE format('CREATE TRIGGER guard_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.awbs_immutable()',r.tablename);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['input_version_results','secrets','system_state'] LOOP
    EXECUTE format('CREATE TRIGGER touch_updated BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.awbs_touch()',t);
  END LOOP;
  CREATE TRIGGER guard_delete BEFORE DELETE ON public.input_version_results FOR EACH ROW EXECUTE FUNCTION public.awbs_delete_guard();
  CREATE TRIGGER append_only BEFORE UPDATE ON public.input_version_results FOR EACH ROW EXECUTE FUNCTION public.awbs_immutable();
  GRANT SELECT,INSERT ON public.input_version_results TO awbs_app;
  GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO awbs_app;
  FOR r IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,pg_temp',r.signature);
    EXECUTE format('ALTER FUNCTION %s OWNER TO awbs_data_owner',r.signature);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC',r.signature);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.reset_project(int,text,bool,text),public.lock_epoch(int),
  public.prune_change_events(),public.complete_cleanup(uuid,int,bool,jsonb),
  public.awbs_valid_judgements(jsonb,text[]),public.awbs_valid_hold_reasons(jsonb) TO awbs_app;
INSERT INTO public.system_state(id) VALUES(1) ON CONFLICT DO NOTHING;
