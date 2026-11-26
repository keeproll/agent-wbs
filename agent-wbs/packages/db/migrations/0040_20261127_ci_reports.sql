-- job이 없는 야간 점검도 시작한 Runner만 갱신한다.
ALTER TABLE public.ci_runs ADD COLUMN reporter text;
--> statement-breakpoint
ALTER TABLE public.ci_steps ADD COLUMN duration_ms bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.ci_steps ADD CONSTRAINT ci_step_duration CHECK (duration_ms >= 0 AND duration_ms <= 9007199254740991);
--> statement-breakpoint
-- H→H′ 보존 증거를 남겨 자동 완료와 팀장 완료 버튼이 같은 근거를 쓴다.
ALTER TABLE public.merge_queue ADD COLUMN head_sync jsonb;
--> statement-breakpoint
ALTER TABLE public.merge_queue ADD COLUMN merge_parents jsonb;
