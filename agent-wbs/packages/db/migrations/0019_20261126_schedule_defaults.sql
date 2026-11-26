-- M2-08: 일정 정책 기본값(owner 결정 2026-11-26 아이템 7) — 가정 가동률 60%, 재조정 임계값 1일.
-- 1) system seed가 새 DB와 설정까지 지우는 초기화(keepSettings=false)에서 이 값을 넣는다. seed_system()의 나머지는 0016과 같다.
-- 2) 기존 DB는 비어 있는(null) 칸만 채운다. 팀장이 이미 넣은 값은 덮어쓰지 않는다.
CREATE OR REPLACE FUNCTION public.seed_system() RETURNS pg_catalog.void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE cli pg_catalog.text; models pg_catalog.text[]; model pg_catalog.text; effort pg_catalog.text; level pg_catalog.int4;
BEGIN
  INSERT INTO public.system_state(id) VALUES(1) ON CONFLICT DO NOTHING;
  PERFORM epoch FROM public.system_state WHERE id=1 FOR SHARE;
  INSERT INTO public.app_settings(singleton,heartbeat_seconds,heartbeat_misses,split,stage_pct,timezone,model_settings)
    VALUES(true,60,3,'{"maxH":4,"minH":0.5,"maxFiles":8,"testIn":true,"dir":"layer","on":{"one":true,"domain":true,"size":true,"verify":true,"revert":true,"cg":true,"contract":true,"irrev":true,"refactor":true,"unknown":true}}'::pg_catalog.jsonb,'{"planning":0,"approval":0,"ready":0,"failed":20,"running":35,"paused":40,"rework":50,"qa":65,"verifying":80,"gate":90,"done":100,"cancelled":0}'::pg_catalog.jsonb,'Asia/Seoul',public.default_model_settings()) ON CONFLICT DO NOTHING;
  INSERT INTO public.exec_policy(singleton,on_usage,on_rework,esc_notify,floors,live_inject,auto_retry_limit,auto_rework_limit)
    VALUES(true,'wait','up1',2,'{"verifyGeDev":true,"dbHigh":true}',false,2,3) ON CONFLICT DO NOTHING;
  -- G §3 fixes cp_auto=true; auto_replan has no explicit confirmed default in G.
  -- owner 결정 2026-11-26 아이템 7: 가정 가동률 60%, 재조정 임계값 1일(설정에서 변경 가능).
  INSERT INTO public.schedule_policy(singleton,window_days,min_hours,cp_auto,assume_rate,threshold_days) VALUES(true,7,72,true,0.6,1) ON CONFLICT DO NOTHING;
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
END $$;--> statement-breakpoint
UPDATE public.schedule_policy SET assume_rate=coalesce(assume_rate,0.6), threshold_days=coalesce(threshold_days,1)
  WHERE assume_rate IS NULL OR threshold_days IS NULL;
