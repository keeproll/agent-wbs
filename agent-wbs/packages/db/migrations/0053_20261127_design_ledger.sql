-- 계약이 없는 초기 분석에서도 기술 결정을 먼저 승인한다. 커밋을 지어내지 않고 버전만 기록한다.
ALTER TABLE public.design_versions ALTER COLUMN snapshot DROP NOT NULL;
--> statement-breakpoint
-- 구성도와 소유권의 부가 정보도 같은 커밋의 캐시로 보관한다.
ALTER TABLE public.design_snapshots ADD COLUMN content jsonb NOT NULL DEFAULT '{}'::jsonb;
