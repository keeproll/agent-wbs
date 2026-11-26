-- UAT-PROJECT-10: 설명·시작일을 저장한다. 기존 프로젝트의 시작일은 종전 일정 조회와 같은 서울 등록일이다.
ALTER TABLE public.projects ADD COLUMN description text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE public.projects ADD COLUMN start_date date;
--> statement-breakpoint
UPDATE public.projects SET start_date=(created_at AT TIME ZONE 'Asia/Seoul')::date;
--> statement-breakpoint
ALTER TABLE public.projects ALTER COLUMN start_date SET NOT NULL;
--> statement-breakpoint
ALTER TABLE public.projects ALTER COLUMN start_date SET DEFAULT (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date;
--> statement-breakpoint
-- 실제 관측 완료 시각과 팀장의 확인 요청 번호를 나눈다. 접수만으로 확인 완료라고 보이면 안 되기 때문이다.
ALTER TABLE public.projects ADD COLUMN input_checked_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.projects ADD COLUMN input_check_request integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- 미제출 초안 삭제는 목록에서 숨기는 표시다. G122의 전후·주체 이력을 지우지 않기 위해 행과 이벤트를 보존한다.
ALTER TABLE public.change_proposals ADD COLUMN deleted_at timestamptz;
