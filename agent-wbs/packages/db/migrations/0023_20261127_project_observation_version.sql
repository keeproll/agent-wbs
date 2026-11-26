-- Runner의 관측 시각은 팀장 편집 버전이 아니다. 0018의 읽음 표시처럼 실제 편집과 구분해 불필요한 409를 막는다.
CREATE FUNCTION public.awbs_touch_project() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.created_at := OLD.created_at;
  -- updated_at만 올리는 요청은 입력 분석 같은 자식 데이터 편집을 대표하므로 그대로 증가시킨다.
  IF NEW.input_checked_at IS DISTINCT FROM OLD.input_checked_at
     AND (to_jsonb(NEW) - ARRAY['input_checked_at','updated_at']) = (to_jsonb(OLD) - ARRAY['input_checked_at','updated_at']) THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := greatest(clock_timestamp(), OLD.updated_at + interval '1 microsecond');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER touch_updated ON public.projects;
--> statement-breakpoint
CREATE TRIGGER touch_updated BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.awbs_touch_project();
