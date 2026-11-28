-- M8 선행 수정: 「최신 검증」을 벽시계(created_at) 대신 뒤로 가지 않는 저장 순번(record_no)으로 고른다(M5·M7 원칙, 0027·0037과 같은 방식).
--
-- 무엇이 문제인가: 이 PC 시계는 약 32초마다 약 2.3초 뒤로 간다. 그러면 나중에 저장한 검증의 시각(created_at)이 더 이를 수 있다.
--   화면이 시각으로 최신을 고르면 옛 FAIL을 최신으로 보고 재작업 지시를 옛 시도에 연결할 수 있다.
-- 무엇을 하나: 검증 표에 저장 순번(record_no, bigserial)을 더한다. 새 행은 저장하는 순간 번호를 받고, 번호는 바뀌지 않는다.
--   API는 이 값을 검증의 seq로 내보낸다(GET /api/verifications, GET /api/tasks/:taskKey/verifications).
-- 기존 행 번호: 그 검증의 실행 시도 저장 순번(task_attempts.record_no) 순서로 매긴다. 같으면(있을 수 없지만) 시각 → id.
--   왜 시도 순서인가: 검증은 시도 하나에 하나뿐이고(verifications_attempt_unique), 서버의 「최신 검증」 판정(gate·ci)도 시도 번호(attempt_no) 순이다.
--   시도 저장 순번은 같은 Task 안에서 시도 번호와 같은 순서라(시도는 한 번에 하나만 열린다), 옛 행도 서버 판정과 같은 순서가 된다.
-- 검증 표는 덧붙이기만 하는 표라(0001 guards) 번호를 다시 매기는 동안만 기록 트리거를 끈다(0037과 같은 방법).
DO $$ DECLARE old_role text := current_setting('session_replication_role'); BEGIN
  PERFORM set_config('session_replication_role','replica',true);
  ALTER TABLE public.verifications ADD COLUMN record_no bigserial NOT NULL;
  WITH ordered AS (
    SELECT v.id,row_number() OVER (ORDER BY a.record_no,v.created_at,v.id) n
    FROM public.verifications v JOIN public.task_attempts a ON a.id=v.attempt)
  UPDATE public.verifications v SET record_no=o.n FROM ordered o WHERE o.id=v.id;
  PERFORM setval('public.verifications_record_no_seq',coalesce((SELECT max(record_no) FROM public.verifications),1),EXISTS(SELECT 1 FROM public.verifications));
  ALTER TABLE public.verifications ADD CONSTRAINT verifications_record_no_unique UNIQUE(record_no);
  GRANT USAGE, SELECT ON SEQUENCE public.verifications_record_no_seq TO awbs_app;
  PERFORM set_config('session_replication_role',old_role,true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('session_replication_role',old_role,true);
  RAISE;
END $$;
