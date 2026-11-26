-- Old jobs have no cause key; preserve them under their recorded IDs, without rewriting results.
ALTER TABLE public.runner_jobs DISABLE TRIGGER job_update;
UPDATE public.runner_jobs SET dedup_key='legacy:'||id::text WHERE dedup_key IS NULL;
ALTER TABLE public.runner_jobs ENABLE TRIGGER job_update;
ALTER TABLE "runner_jobs" ALTER COLUMN "dedup_key" SET NOT NULL;
