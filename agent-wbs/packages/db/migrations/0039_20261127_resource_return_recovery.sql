ALTER TABLE "execution_holds" DROP CONSTRAINT "execution_holds_job_unique";--> statement-breakpoint
ALTER TABLE "runner_jobs" ADD COLUMN "resource_returns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_jobs" ADD COLUMN "resource_retry_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_job_hold" ON "execution_holds" USING btree ("job") WHERE "execution_holds"."closed_at" is null;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.awbs_handover() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.execution_holds%ROWTYPE; b public.execution_holds%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.execution_holds WHERE id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF a.lock_state='handed_over' THEN
    SELECT * INTO b FROM public.execution_holds WHERE job=a.handed_to_job AND lock_from_job=a.job ORDER BY fence DESC NULLS LAST LIMIT 1;
    IF NOT FOUND OR b.lock_from_job IS DISTINCT FROM a.job OR b.epoch<>a.epoch OR b.project_id IS DISTINCT FROM a.project_id OR b.task IS DISTINCT FROM a.task
      OR b.conflict_group IS DISTINCT FROM a.conflict_group THEN
      RAISE EXCEPTION 'handover requires reciprocal receiving hold' USING ERRCODE='23514';
    END IF;
  END IF;
  IF a.lock_from_job IS NOT NULL THEN
    SELECT * INTO b FROM public.execution_holds WHERE job=a.lock_from_job AND handed_to_job=a.job AND lock_state='handed_over' ORDER BY fence DESC NULLS LAST LIMIT 1;
    IF NOT FOUND OR b.lock_state<>'handed_over' OR b.handed_to_job IS DISTINCT FROM a.job OR b.epoch<>a.epoch OR b.project_id IS DISTINCT FROM a.project_id
       OR b.task IS DISTINCT FROM a.task OR b.conflict_group IS DISTINCT FROM a.conflict_group THEN
      RAISE EXCEPTION 'receiving hold requires reciprocal handover' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

--> statement-breakpoint
CREATE INDEX hold_job_history ON public.execution_holds(job,fence);
