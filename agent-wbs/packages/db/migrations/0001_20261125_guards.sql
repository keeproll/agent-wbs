-- Custom SQL migration file, put your code below! --
-- SQL-only permissions and triggers intentionally live outside Drizzle's table snapshot.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'awbs_app') THEN
    CREATE ROLE awbs_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'awbs_app' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)) THEN
    RAISE EXCEPTION 'awbs_app must be an unprivileged application role';
  END IF;
END $$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO awbs_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO awbs_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM awbs_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO awbs_app;
--> statement-breakpoint
CREATE FUNCTION public.awbs_touch() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.created_at := OLD.created_at;
  NEW.updated_at := greatest(clock_timestamp(), OLD.updated_at + interval '1 microsecond');
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.awbs_delete_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_setting('awbs.reset', true) = 'on'
     AND current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = TG_RELID)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'physical deletion requires reset_project' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE FUNCTION public.awbs_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE FUNCTION public.awbs_terminal_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'attempt is closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.awbs_subagent_version() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['allowed','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['allowed','updated_at']) THEN
    RAISE EXCEPTION 'subagent definition version is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.awbs_session_update() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.runner_id IS DISTINCT FROM OLD.runner_id
     OR (NEW.ended_at IS NOT NULL AND (NEW.ended_at < OLD.started_at OR NEW.end_reason IS NULL)) THEN
    RAISE EXCEPTION 'session identity and closed sessions are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.awbs_hold_transition() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'closed hold is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.job <> OLD.job OR NEW.epoch <> OLD.epoch THEN
    RAISE EXCEPTION 'hold identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.slot_state <> OLD.slot_state AND NOT (
    (OLD.slot_state = 'none' AND NEW.slot_state = 'reserved') OR
    (OLD.slot_state = 'reserved' AND NEW.slot_state IN ('active','none','unconfirmed')) OR
    (OLD.slot_state = 'active' AND NEW.slot_state IN ('none','unconfirmed')) OR
    (OLD.slot_state = 'unconfirmed' AND NEW.slot_state = 'none')
  ) THEN
    RAISE EXCEPTION 'invalid slot transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.slot_state = 'none' AND OLD.slot_state <> 'none' AND NEW.release_proof IS NULL THEN
    RAISE EXCEPTION 'slot release requires proof' USING ERRCODE = '23514';
  END IF;
  IF NEW.slot_state = 'reserved' AND OLD.slot_state = 'none' THEN NEW.release_proof := NULL; END IF;
  IF NEW.lock_state <> OLD.lock_state AND NOT (
    (OLD.lock_state = 'none' AND NEW.lock_state = 'held') OR
    (OLD.lock_state = 'held' AND NEW.lock_state IN ('handed_over','released','orphaned'))
  ) THEN
    RAISE EXCEPTION 'invalid lock transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER attempt_terminal BEFORE UPDATE ON public.task_attempts FOR EACH ROW EXECUTE FUNCTION public.awbs_terminal_attempt();
CREATE TRIGGER hold_transition BEFORE UPDATE ON public.execution_holds FOR EACH ROW EXECUTE FUNCTION public.awbs_hold_transition();
CREATE TRIGGER subagent_version BEFORE UPDATE ON public.subagent_defs FOR EACH ROW EXECUTE FUNCTION public.awbs_subagent_version();
CREATE TRIGGER session_update BEFORE UPDATE ON public.runner_sessions FOR EACH ROW EXECUTE FUNCTION public.awbs_session_update();
--> statement-breakpoint
DO $$
DECLARE r record; t text;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='updated_at' LOOP
    EXECUTE format('CREATE TRIGGER touch_updated BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.awbs_touch()', r.table_name);
  END LOOP;
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('CREATE TRIGGER guard_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.awbs_delete_guard()', r.tablename);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['input_versions','planning_job_logs','task_estimates','change_proposal_events','runner_job_events','attempt_files','attempt_observations','verifications','verification_invalidations','defects','defect_events','evidence','runner_hosts','runner_concurrency_log','schedule_baselines','baseline_items','replans','replan_moves','reports','mail_log','notify_log','tech_decision_events','design_versions','task_history','change_events'] LOOP
    EXECUTE format('REVOKE UPDATE ON public.%I FROM awbs_app', t);
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.awbs_immutable()', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- A UUID from another project must not satisfy a project-scoped reference.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='project_id' LOOP
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_schema='public' AND table_name=r.table_name AND column_name='id') THEN
      EXECUTE format('ALTER TABLE public.%I ADD UNIQUE (project_id,id)', r.table_name);
    END IF;
  END LOOP;
  FOR r IN
    SELECT c.conrelid::regclass AS child, c.confrelid::regclass AS parent, a.attname AS col, c.conrelid::regclass::text AS child_name
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
    WHERE c.contype='f' AND cardinality(c.conkey)=1 AND a.attname<>'project_id'
      AND EXISTS (SELECT FROM pg_attribute WHERE attrelid=c.conrelid AND attname='project_id')
      AND EXISTS (SELECT FROM pg_attribute WHERE attrelid=c.confrelid AND attname='project_id')
  LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (project_id,%I) REFERENCES %s(project_id,id) ON DELETE RESTRICT', r.child, 'scope_' || r.child_name || '_' || r.col, r.col, r.parent);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.reset_project(expected_epoch integer, confirm_name text, keep_settings boolean, reset_actor text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_epoch integer; p public.projects%ROWTYPE; deleted_count integer; holds jsonb; branches jsonb; prs jsonb; t text;
BEGIN
  SELECT epoch INTO STRICT current_epoch FROM public.system_state WHERE id=1 FOR UPDATE;
  IF expected_epoch IS DISTINCT FROM current_epoch THEN RAISE EXCEPTION 'EPOCH_MISMATCH' USING ERRCODE='40001'; END IF;
  SELECT * INTO p FROM public.projects FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF confirm_name IS DISTINCT FROM p.name THEN RAISE EXCEPTION 'confirmName mismatch' USING ERRCODE='22023'; END IF;
  IF keep_settings IS NULL OR reset_actor IS NULL OR reset_actor='' THEN RAISE EXCEPTION 'reset arguments required' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO deleted_count FROM public.tasks;
  SELECT coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) INTO holds FROM public.execution_holds h WHERE slot_state<>'none' OR lock_state='held';
  SELECT coalesce(jsonb_agg(DISTINCT branch), '[]'::jsonb) INTO branches FROM public.task_attempts WHERE branch LIKE 'agent/%';
  SELECT coalesce(jsonb_agg(DISTINCT pr), '[]'::jsonb) INTO prs FROM public.task_attempts WHERE pr IS NOT NULL;
  INSERT INTO public.file_delete_queue(epoch,path,reason) VALUES(current_epoch,current_epoch::text || '/', 'project-reset');
  INSERT INTO public.runner_commands(kind,epoch,payload,status) VALUES('reset-cleanup',current_epoch,
    jsonb_build_object('epochPath',current_epoch::text || '/', 'holds',holds) ||
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
    FOREACH t IN ARRAY ARRAY['mail_recipients','mail_settings','notify_rules','notify_settings','app_settings','ci_settings','blackout_days','schedule_policy','cli_observation_grades','exec_policy','concurrency_settings','runner_readiness','runner_concurrency_log','runner_hosts','runner_sessions','agent_usage','agent_efforts','agent_models','subagent_defs','external_write_authority'] LOOP
      EXECUTE format('DELETE FROM public.%I', t);
    END LOOP;
    DELETE FROM public.secrets WHERE key IS DISTINCT FROM (SELECT secret_key FROM public.github_settings);
  END IF;
  UPDATE public.system_state SET epoch=current_epoch+1, cleanup_status='pending' WHERE id=1;
  INSERT INTO public.reset_log(epoch,actor,deleted_task_count,keep_settings,runner_cleanup_status) VALUES(current_epoch+1,reset_actor,deleted_count,keep_settings,'pending');
  PERFORM set_config('awbs.reset','off',true);
  RETURN current_epoch+1;
END $$;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_project(integer,text,boolean,text) TO awbs_app;
REVOKE INSERT, UPDATE ON public.reset_log, public.system_state FROM awbs_app;
--> statement-breakpoint
-- SELECT FOR SHARE requires UPDATE privilege; expose only the epoch lock to the app.
CREATE FUNCTION public.lock_epoch(expected_epoch integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e integer;
BEGIN
  SELECT epoch INTO STRICT e FROM public.system_state WHERE id=1 FOR SHARE;
  IF e IS DISTINCT FROM expected_epoch THEN RAISE EXCEPTION 'EPOCH_MISMATCH' USING ERRCODE='40001'; END IF;
  RETURN e;
END $$;
REVOKE ALL ON FUNCTION public.lock_epoch(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_epoch(integer) TO awbs_app;
