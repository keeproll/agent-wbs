-- P L2282의 다시 점검은 요청 번호만 올린다. 실제 보고가 올 때까지 마지막 결과를 보존한다.
ALTER TABLE public.app_settings ADD COLUMN readiness_check_request integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TYPE public.job_kind ADD VALUE 'github_check';
--> statement-breakpoint
-- 기존 demo 설치도 첫 메시지 번호가 중복되지 않게 한다. 이미 더 큰 번호는 낮추지 않는다.
INSERT INTO public.counters(project_id,kind,value)
SELECT project_id,'message',max(substring(msg_key from 5)::bigint) FROM public.messages WHERE msg_key ~ '^MSG-[0-9]+$' GROUP BY project_id
ON CONFLICT(project_id,kind) DO UPDATE SET value=greatest(counters.value,excluded.value);
--> statement-breakpoint
-- 계약 Hours는 소수 시간도 받는다. 정수 열 때문에 정상 입력이 500으로 실패하지 않게 한다.
ALTER TABLE public.schedule_policy ALTER COLUMN min_hours TYPE numeric;
--> statement-breakpoint
ALTER TABLE public.github_settings ADD COLUMN checked_at timestamptz;
--> statement-breakpoint
-- 확인은 원인 해소가 아니다. 입력 이력 재작성 같은 보호 상태를 확인 버튼이 풀면 안 된다.
ALTER TABLE public.alerts ADD COLUMN acknowledged_at timestamptz;
--> statement-breakpoint
-- 표시 번호만 고친다. 시도 ID와 실행 결과는 그대로 보존한다(data-model §1).
ALTER TABLE public.task_attempts DISABLE TRIGGER attempt_terminal;
--> statement-breakpoint
UPDATE public.task_attempts a SET attempt_key='ATT-'||substring(t.task_key from 6)||'-'||a.attempt_no
FROM public.tasks t WHERE t.id=a.task AND a.attempt_key=t.task_key||'-A'||a.attempt_no;
--> statement-breakpoint
ALTER TABLE public.task_attempts ENABLE TRIGGER attempt_terminal;
