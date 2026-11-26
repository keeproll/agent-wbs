-- 교차 리뷰 지적 1: 0013의 NOT VALID CHECK는 이전 행을 UPDATE할 때도 검사해서, 이전 분할 CP를 반려하거나
-- 이전 CI 실행의 결과를 저장할 수 없었다. 같은 규칙을 트리거로 바꾼다.
-- 새 행과, 규칙을 지키던 행은 전과 같이 검사한다. 이미 규칙을 어긴 이전 행은 그 관계(출처·단계·job)를
-- 그대로 둔 갱신만 허용한다. 원래 Task나 job을 알 수 없으므로 임의로 채우지 않는다.
ALTER TABLE "change_proposals" DROP CONSTRAINT "cp_split_source";--> statement-breakpoint
ALTER TABLE "ci_runs" DROP CONSTRAINT "ci_job_owner";--> statement-breakpoint
CREATE FUNCTION public.awbs_cp_split_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.source='split' AND NEW.source_id IS NULL
     AND NOT (TG_OP='UPDATE' AND OLD.source='split' AND OLD.source_id IS NULL) THEN
    RAISE EXCEPTION 'split proposal requires source_id' USING ERRCODE='23514', CONSTRAINT='cp_split_source',
      TABLE='change_proposals';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER cp_split_source BEFORE INSERT OR UPDATE ON public.change_proposals
  FOR EACH ROW EXECUTE FUNCTION public.awbs_cp_split_source();--> statement-breakpoint
CREATE FUNCTION public.awbs_ci_job_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.stage<>3 AND NEW.job IS NULL
     AND NOT (TG_OP='UPDATE' AND OLD.stage=NEW.stage AND OLD.job IS NULL) THEN
    RAISE EXCEPTION 'only nightly CI runs may have no job' USING ERRCODE='23514', CONSTRAINT='ci_job_owner',
      TABLE='ci_runs';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER ci_job_owner BEFORE INSERT OR UPDATE ON public.ci_runs
  FOR EACH ROW EXECUTE FUNCTION public.awbs_ci_job_owner();--> statement-breakpoint
ALTER FUNCTION public.awbs_cp_split_source() OWNER TO awbs_data_owner;--> statement-breakpoint
ALTER FUNCTION public.awbs_ci_job_owner() OWNER TO awbs_data_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.awbs_cp_split_source(), public.awbs_ci_job_owner() FROM PUBLIC;
