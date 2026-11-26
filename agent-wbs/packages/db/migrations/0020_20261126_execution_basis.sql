ALTER TABLE "ci_runs" ADD COLUMN "spec_revision" integer;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "input_version" uuid;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_input_version_input_versions_id_fk" FOREIGN KEY ("input_version") REFERENCES "public"."input_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ci_runs_input_version_idx" ON public.ci_runs USING btree (input_version);
--> statement-breakpoint
-- 과거 검사의 근거는 당시 시도에서 복원한다. 현재 명세로 덮으면 낡은 PASS가 살아나므로 금지한다.
UPDATE public.ci_runs c SET spec_revision=a.spec_revision,input_version=a.input_version FROM public.task_attempts a WHERE a.id=c.attempt;
--> statement-breakpoint
-- 새 ① 검사는 시작 시점의 명세·입력을 서버가 고정한다. 명세 변경 후에도 같은 코드에서 다시 검사할 수 있다.
CREATE FUNCTION public.awbs_ci_basis() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.spec_revision,NEW.input_version,NEW.task,NEW.attempt) IS DISTINCT FROM (OLD.spec_revision,OLD.input_version,OLD.task,OLD.attempt) THEN
      RAISE EXCEPTION 'CI basis is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.stage=1 AND NEW.task IS NOT NULL THEN
    SELECT s.revision,coalesce(t.src_input_version,(SELECT id FROM public.input_versions WHERE project_id=t.project_id ORDER BY v DESC LIMIT 1))
      INTO NEW.spec_revision,NEW.input_version FROM public.tasks t JOIN public.task_specs s ON s.task=t.id WHERE t.id=NEW.task;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
ALTER FUNCTION public.awbs_ci_basis() OWNER TO awbs_data_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.awbs_ci_basis() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER ci_basis BEFORE INSERT OR UPDATE ON public.ci_runs FOR EACH ROW EXECUTE FUNCTION public.awbs_ci_basis();
--> statement-breakpoint
-- 현재 브랜치의 head는 바뀔 수 있지만 종료된 시도의 head는 감사 기록이므로 보존한다.
ALTER TABLE public.tasks ADD COLUMN execution_head_sha text;
