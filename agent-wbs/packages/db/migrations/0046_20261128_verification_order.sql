-- M8 선행 수정: 「최신 검증」을 벽시계(created_at) 대신 뒤로 가지 않는 저장 순번(record_no)으로 고른다(M5·M7 원칙, 0027·0037과 같은 방식).
--
-- 무엇이 문제인가: 이 PC 시계는 약 32초마다 약 2.3초 뒤로 간다. 그러면 나중에 저장한 검증의 시각(created_at)이 더 이를 수 있다.
--   화면이 시각으로 최신을 고르면 옛 FAIL을 최신으로 보고 재작업 지시를 옛 시도에 연결할 수 있다.
-- 무엇을 하나: 검증 표에 저장 순번(record_no, bigserial)을 더한다. 새 행은 저장하는 순간 번호를 받고, 번호는 바뀌지 않는다.
--   API는 이 값을 검증의 seq로 내보낸다(GET /api/verifications, GET /api/tasks/:taskKey/verifications).
-- 기존 행 번호(Codex 리뷰 P2-1 반영): 검증이 **실제로 저장된 순서**를 상태 이력(state_log, 0028)에서 읽어 매긴다.
--   (1) 이력에 그 검증의 삽입 기록(op='insert')이 있으면: 그 기록을 남긴 트랜잭션의 커밋 순서로 매긴다.
--       커밋 순서 = commit_log.committed_at(커밋 직전에 행 잠금 아래에서 「이전 값 + 1µs 이상」으로 매기는 커밋 시계, 0028).
--       이 값은 벽시계가 뒤로 가도 줄지 않고, 트랜잭션마다 다르다. 같은 트랜잭션 안에서는 이력 순번(seq) 순이다.
--       왜 시도 순서가 아닌가: 여러 Task가 동시에 실행되면 먼저 시작한 Task 1이 Task 2보다 늦게 끝나 검증이 나중에 저장된다.
--       시도 생성 순서로 채우면 이 경우 저장 순서가 뒤집힌다(리뷰 재현: 시도 T1→T2, 검증 T2→T1).
--   (2) 삽입 기록이 없으면(이력이 시작되기 전 행 = 0028의 seed 행, 또는 기록을 끈 채 넣은 행): 정확한 전체 순서를 되살릴 수 없다.
--       이 행들은 (1)의 모든 행보다 먼저(작은 번호) 두고, 그 안에서는 시도 저장 순번(task_attempts.record_no) → 시각 → id 순으로 매긴다.
--       한계: 이 무리 안에서 Task 사이의 순서는 「시도 시작 순서」 근사다. 같은 Task 안에서는 시도 번호 순과 같다(서버 「최신 검증」 판정과 일치).
-- 검증 표는 덧붙이기만 하는 표라(0001 guards) 번호를 다시 매기는 동안만 기록 트리거를 끈다(0037과 같은 방법).
DO $$ DECLARE old_role text := current_setting('session_replication_role'); BEGIN
  PERFORM set_config('session_replication_role','replica',true);
  ALTER TABLE public.verifications ADD COLUMN record_no bigserial NOT NULL;
  WITH ins AS (
    SELECT DISTINCT ON (l.row_id) l.row_id,c.committed_at,l.seq
    FROM public.state_log l LEFT JOIN public.commit_log c ON c.xid=l.xid
    WHERE l.tbl='verifications' AND l.op='insert'
    ORDER BY l.row_id,l.seq),
  ordered AS (
    SELECT v.id,row_number() OVER (ORDER BY (i.row_id IS NOT NULL),i.committed_at,i.seq,a.record_no,v.created_at,v.id) n
    FROM public.verifications v JOIN public.task_attempts a ON a.id=v.attempt LEFT JOIN ins i ON i.row_id=v.id)
  UPDATE public.verifications v SET record_no=o.n FROM ordered o WHERE o.id=v.id;
  PERFORM setval('public.verifications_record_no_seq',coalesce((SELECT max(record_no) FROM public.verifications),1),EXISTS(SELECT 1 FROM public.verifications));
  ALTER TABLE public.verifications ADD CONSTRAINT verifications_record_no_unique UNIQUE(record_no);
  GRANT USAGE, SELECT ON SEQUENCE public.verifications_record_no_seq TO awbs_app;
  PERFORM set_config('session_replication_role',old_role,true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('session_replication_role',old_role,true);
  RAISE;
END $$;
