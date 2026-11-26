-- 계약 보완(2026-11-26). 번호 0015는 M2 작업(platform_epoch_lock)이 쓰고 있어 0016을 쓴다.
-- 1) GitHub 권한 3상태(조정자 결정): scopes를 권한별 verified·unverified·missing 객체로 바꾸고 경고 문구 칸을 둔다.
--    옛 값(text[])의 뜻을 알 수 없으므로 추정하지 않고 null(확인 안 함)로 둔다. 다음 연결 확인 보고가 새 값을 채운다.
ALTER TABLE "github_settings" ALTER COLUMN "scopes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "github_settings" ALTER COLUMN "scopes" SET DATA TYPE jsonb USING NULL;--> statement-breakpoint
ALTER TABLE "github_settings" ADD COLUMN "warning" text;--> statement-breakpoint
-- 권한 하나가 JSON null이면 비교가 SQL null이 되어 CHECK를 지나간다. 객체 검사 전체가 참일 때만 통과시킨다(is true).
ALTER TABLE "github_settings" ADD CONSTRAINT "github_scopes_shape" CHECK ("github_settings"."scopes" is null or (jsonb_typeof("github_settings"."scopes")='object' and "github_settings"."scopes" ?& array['contents','pulls','statuses','metadata'] and ("github_settings"."scopes" - array['contents','pulls','statuses','metadata'])='{}'::jsonb and "github_settings"."scopes"->>'contents' in ('verified','unverified','missing') and "github_settings"."scopes"->>'pulls' in ('verified','unverified','missing') and "github_settings"."scopes"->>'statuses' in ('verified','unverified','missing') and "github_settings"."scopes"->>'metadata' in ('verified','unverified','missing')) is true);--> statement-breakpoint
ALTER TABLE "github_settings" ADD CONSTRAINT "github_warning_text" CHECK ("github_settings"."warning" is null or length(btrim("github_settings"."warning"))>0);--> statement-breakpoint
-- 2) 모델 순서·Claude 모델 목록(owner 2026-11-26 아이템 8). 목록은 모두 아래 등급부터 적는다.
--    초기값의 단일 출처는 이 함수다. seed_system과 아래 채우기가 함께 쓴다. shared DEFAULT_MODEL_SETTINGS와 같아야 한다(테스트로 대조).
CREATE FUNCTION public.default_model_settings() RETURNS pg_catalog.jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT '{"rankOrder":{"Claude":["claude-haiku-5-5","claude-sonnet-5-5","claude-opus-5-5","claude-fable-5-2"],"Codex":["gpt-5.5","gpt-5.6-luna","gpt-5.6-terra","gpt-5.6-sol","gpt-6-luna","gpt-6-astra","gpt-6-sol","gpt-6.1-terra","gpt-6.1-sol","gpt-6.2-astra","gpt-6.2-sol"]},"codexFamilyOrder":["luna","terra","astra","sol"],"claudeModels":["claude-haiku-5-5","claude-sonnet-5-5","claude-opus-5-5","claude-fable-5-2"]}'::pg_catalog.jsonb
$$;--> statement-breakpoint
ALTER FUNCTION public.default_model_settings() OWNER TO awbs_data_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.default_model_settings() FROM PUBLIC;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "model_settings" jsonb;--> statement-breakpoint
-- 이미 seed된 DB의 행은 초기값으로 채운다.
UPDATE "app_settings" SET "model_settings"=public.default_model_settings() WHERE "model_settings" IS NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "model_settings" SET NOT NULL;--> statement-breakpoint
-- 모델 ID 목록 검사: 배열이고, 빈 문자열이 아닌 문자열만, 겹치지 않고, 최소 개수 이상. CHECK에서 쓰므로 IMMUTABLE이다.
CREATE FUNCTION public.awbs_valid_id_list(v pg_catalog.jsonb, min_items pg_catalog.int4) RETURNS pg_catalog.bool
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(v)='array' THEN
    jsonb_array_length(v)>=min_items
    AND NOT EXISTS(SELECT FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e)<>'string' OR length(e#>>'{}')=0)
    AND (SELECT count(DISTINCT e) FROM jsonb_array_elements(v) e)=jsonb_array_length(v)
  ELSE false END
$$;--> statement-breakpoint
ALTER FUNCTION public.awbs_valid_id_list(pg_catalog.jsonb,pg_catalog.int4) OWNER TO awbs_data_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.awbs_valid_id_list(pg_catalog.jsonb,pg_catalog.int4) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.awbs_valid_id_list(pg_catalog.jsonb,pg_catalog.int4) TO awbs_app;--> statement-breakpoint
-- 네 목록은 계약(API)과 같은 조건: 겹치지 않는 문자열 배열, 계열·Claude 목록은 1개 이상.
ALTER TABLE "app_settings" ADD CONSTRAINT "app_model_settings_shape" CHECK ((jsonb_typeof("app_settings"."model_settings")='object' and "app_settings"."model_settings" ?& array['rankOrder','codexFamilyOrder','claudeModels'] and jsonb_typeof("app_settings"."model_settings"->'rankOrder')='object' and ("app_settings"."model_settings"->'rankOrder') ?& array['Claude','Codex'] and public.awbs_valid_id_list("app_settings"."model_settings"->'rankOrder'->'Claude',0) and public.awbs_valid_id_list("app_settings"."model_settings"->'rankOrder'->'Codex',0) and public.awbs_valid_id_list("app_settings"."model_settings"->'codexFamilyOrder',1) and public.awbs_valid_id_list("app_settings"."model_settings"->'claudeModels',1)) is true);--> statement-breakpoint
-- 3) system seed가 모델 설정 초기값을 넣는다. 나머지 내용은 0006과 같다.
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
