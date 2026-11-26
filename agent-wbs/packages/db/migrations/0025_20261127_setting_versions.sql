-- 설정의 편집 버전은 행의 관측 시각과 분리한다. 초기화 시 새 행도 각 묶음의 버전을 갖는다.
ALTER TABLE public.app_settings
  ADD COLUMN split_version timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN blackouts_version timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN workflow_version timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN models_version timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN subagents_version timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
-- 업그레이드 전에 열어 둔 화면의 버전은 그대로 이어받는다.
UPDATE public.app_settings SET split_version=updated_at,blackouts_version=updated_at,workflow_version=updated_at,
  models_version=greatest(updated_at,(SELECT max(updated_at) FROM public.agent_models)),
  subagents_version=greatest(updated_at,(SELECT max(updated_at) FROM public.subagent_defs));
--> statement-breakpoint
ALTER TABLE public.exec_policy ADD COLUMN settings_version timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
UPDATE public.exec_policy SET settings_version=updated_at;
--> statement-breakpoint
ALTER TABLE public.schedule_policy ADD COLUMN settings_version timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
UPDATE public.schedule_policy SET settings_version=updated_at;
--> statement-breakpoint
-- 아직 저장하지 않은 묶음은 null이다. 예산 첫 저장이 동시 실행의 첫 저장으로 보이면 안 된다.
ALTER TABLE public.concurrency_settings ADD COLUMN concurrency_version timestamptz, ADD COLUMN budget_version timestamptz;
--> statement-breakpoint
UPDATE public.concurrency_settings SET concurrency_version=updated_at,budget_version=updated_at;
--> statement-breakpoint
ALTER TABLE public.github_settings ADD COLUMN settings_version timestamptz;
--> statement-breakpoint
UPDATE public.github_settings SET settings_version=updated_at;
