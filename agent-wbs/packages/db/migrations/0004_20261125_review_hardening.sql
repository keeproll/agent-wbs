-- Custom SQL migration file, put your code below! --
-- P0: no writable schema may precede pg_catalog, even in PL/pgSQL declarations.
DO $$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='awbs_app' AND
    (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='awbs_app')) THEN
    RAISE EXCEPTION 'awbs_app must have no privileged attributes or parent roles';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='awbs_data_owner') THEN
    CREATE ROLE awbs_data_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='awbs_data_owner' AND
    (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='awbs_data_owner')) THEN
    RAISE EXCEPTION 'awbs_data_owner must be a dedicated unprivileged NOLOGIN owner';
  END IF;
  EXECUTE format('GRANT awbs_data_owner TO %I',current_user);
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC,awbs_app',current_database());
  GRANT USAGE,CREATE ON SCHEMA public TO awbs_data_owner;
  FOR r IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,pg_temp',r.signature);
    EXECUTE format('ALTER FUNCTION %s OWNER TO awbs_data_owner',r.signature);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC',r.signature);
  END LOOP;
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO awbs_data_owner',r.tablename);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.awbs_valid_judgements(doc pg_catalog.jsonb,allowed pg_catalog.text[])
RETURNS pg_catalog.bool LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE item pg_catalog.jsonb; seen pg_catalog.text[] := '{}';
  nonblank pg_catalog.text := E'[^[:space:]\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]';
BEGIN
  IF doc IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(doc)<>'object' OR doc->'schemaVersion'<>'1'::jsonb
     OR NOT doc ? 'schemaVersion' OR jsonb_typeof(doc->'items')<>'array'
     OR NOT doc ? 'items' OR (doc-ARRAY['schemaVersion','items'])<>'{}'::jsonb THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(doc->'items') LOOP
    IF jsonb_typeof(item)<>'object' OR NOT item ?& ARRAY['rule','result','agreedBy','basis','subjectHash','judgedAt','sourceRef']
       OR (item-ARRAY['rule','result','agreedBy','basis','subjectHash','judgedAt','sourceRef'])<>'{}'::jsonb
       OR NOT (item->>'rule'=ANY(allowed)) OR item->>'rule'=ANY(seen)
       OR jsonb_typeof(item->'rule')<>'string' OR jsonb_typeof(item->'result')<>'string'
       OR item->>'result' NOT IN ('met','not_met')
       OR jsonb_typeof(item->'agreedBy')<>'array' OR jsonb_array_length(item->'agreedBy')<>2
       OR NOT item->'agreedBy' @> '["Claude","Codex"]'::jsonb
       OR jsonb_typeof(item->'basis')<>'string' OR NOT (item->>'basis' ~ nonblank)
       OR jsonb_typeof(item->'sourceRef')<>'string' OR NOT (item->>'sourceRef' ~ nonblank)
       OR jsonb_typeof(item->'subjectHash')<>'string' OR jsonb_typeof(item->'judgedAt')<>'string'
       OR item->>'subjectHash' !~ '^[a-f0-9]{64}$'
       OR item->>'judgedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|\+00:00)$'
    THEN RETURN false; END IF;
    PERFORM (item->>'judgedAt')::timestamptz;
    seen:=array_append(seen,item->>'rule');
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.awbs_valid_hold_reasons(doc pg_catalog.jsonb) RETURNS pg_catalog.bool
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE item pg_catalog.jsonb;
BEGIN
  IF doc IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(doc)<>'object' OR NOT doc ?& ARRAY['holdReasons','issues']
     OR jsonb_typeof(doc->'holdReasons')<>'array' OR jsonb_typeof(doc->'issues')<>'array'
     OR (doc-ARRAY['holdReasons','issues'])<>'{}'::jsonb THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(doc->'holdReasons') LOOP
    IF jsonb_typeof(item)<>'object' OR NOT item ?& ARRAY['code','message']
       OR item->>'code' NOT IN ('JUDGEMENT_MISSING','JUDGEMENT_NOT_MET','ORDER_NOT_PRESERVED','ACTIVE_TASK_BLOCKED')
       OR jsonb_typeof(item->'message')<>'string' OR length(btrim(item->>'message'))=0 THEN RETURN false; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(doc->'issues') LOOP
    IF jsonb_typeof(item)<>'object' OR NOT item ?& ARRAY['index','code','message']
       OR jsonb_typeof(item->'index')<>'number' OR (item->>'index')::numeric<0 OR (item->>'index')::numeric%1<>0
       OR jsonb_typeof(item->'code')<>'string' OR length(btrim(item->>'code'))=0
       OR jsonb_typeof(item->'message')<>'string' OR length(btrim(item->>'message'))=0 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
ALTER FUNCTION public.awbs_valid_judgements(jsonb,text[]) OWNER TO awbs_data_owner;
ALTER FUNCTION public.awbs_valid_hold_reasons(jsonb) OWNER TO awbs_data_owner;
REVOKE ALL ON FUNCTION public.awbs_valid_judgements(jsonb,text[]),public.awbs_valid_hold_reasons(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.awbs_valid_judgements(jsonb,text[]),public.awbs_valid_hold_reasons(jsonb) TO awbs_app;
