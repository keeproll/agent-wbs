-- M2-08(조정자 결정 2026-11-26): 메시지 읽음 표시는 messages.updatedAt을 올리지 않는다(contracts §1.3 「메시지 읽음」).
-- 공통 트리거 awbs_touch()는 모든 UPDATE에서 updated_at을 올리므로, messages에만 「read_at만 바뀌면 유지」 규칙을 둔다.
-- 다른 열이 하나라도 바뀌면 기존과 같이 단조 증가시킨다. 앱이 updated_at을 직접 넣어도 무시한다.
CREATE FUNCTION public.awbs_touch_message() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.created_at := OLD.created_at;
  IF (to_jsonb(NEW) - ARRAY['read_at','updated_at']) = (to_jsonb(OLD) - ARRAY['read_at','updated_at']) THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := greatest(clock_timestamp(), OLD.updated_at + interval '1 microsecond');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER touch_updated ON public.messages;
--> statement-breakpoint
CREATE TRIGGER touch_updated BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.awbs_touch_message();
