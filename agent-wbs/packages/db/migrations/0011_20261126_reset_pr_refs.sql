CREATE OR REPLACE FUNCTION public.reset_project(expected_epoch pg_catalog.int4, confirm_name pg_catalog.text, keep_settings pg_catalog.bool, reset_actor pg_catalog.text)
RETURNS pg_catalog.int4 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,pg_temp AS $$
DECLARE current_epoch pg_catalog.int4; p public.projects%ROWTYPE; deleted_count pg_catalog.int4; holds pg_catalog.jsonb; branches pg_catalog.jsonb; prs pg_catalog.jsonb; unparsed_prs pg_catalog.jsonb; t pg_catalog.text; generation pg_catalog.int4;
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
  -- Bound the text before casting; retain every unparseable reference for reconciliation.
  WITH recorded AS (
    SELECT jsonb_build_object('source','task_attempts','id',id,'value',pr) AS ref FROM public.task_attempts WHERE pr IS NOT NULL
    UNION ALL SELECT jsonb_build_object('source','ci_runs','id',id,'value',pr) FROM public.ci_runs WHERE pr IS NOT NULL
    UNION ALL SELECT jsonb_build_object('source','merge_queue','id',id,'value',pr) FROM public.merge_queue WHERE pr IS NOT NULL
    UNION ALL SELECT jsonb_build_object('source','runner_jobs','id',id,'value',payload->'pr') FROM public.runner_jobs WHERE payload ? 'pr'
    UNION ALL SELECT jsonb_build_object('source','runner_commands','id',id,'value',v)
      FROM public.runner_commands CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(payload->'prs')='array' THEN payload->'prs'
          WHEN payload ? 'prs' THEN jsonb_build_array(payload->'prs') ELSE '[]'::jsonb END) v
    UNION ALL SELECT v FROM public.runner_commands CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(payload->'unparsedPrs')='array' THEN payload->'unparsedPrs' ELSE '[]'::jsonb END) v
  ), candidates AS (
    SELECT ref,ltrim(ref->>'value','0') AS digits FROM recorded
  ), parsed AS (
    SELECT ref,CASE WHEN ref->>'value' ~ '^[0-9]+$' AND length(digits) BETWEEN 1 AND 10
      AND (length(digits)<10 OR digits COLLATE "C"<='2147483647') THEN digits::int END AS pr FROM candidates
  )
  SELECT coalesce(jsonb_agg(DISTINCT pr ORDER BY pr) FILTER (WHERE pr IS NOT NULL),'[]'::jsonb),
    coalesce(jsonb_agg(DISTINCT ref ORDER BY ref) FILTER (WHERE pr IS NULL),'[]'::jsonb)
    INTO prs,unparsed_prs FROM parsed;
  SELECT a.generation INTO generation FROM public.external_write_authority a;
  INSERT INTO public.file_delete_queue(epoch,path,reason) VALUES(current_epoch,current_epoch::text || '/', 'project-reset');
  INSERT INTO public.runner_commands(kind,epoch,payload,status) VALUES('reset-cleanup',current_epoch,
    jsonb_build_object('epochPath',current_epoch::text || '/', 'holds',holds,'generation',generation,'unparsedPrs',unparsed_prs) ||
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
