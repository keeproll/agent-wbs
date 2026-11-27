-- 0038(옛 0047, M6 통합에서 재번호). M6-02(Codex 리뷰 P2, 재리뷰 3·4차 P2-2): 옛 보고서 스냅샷(M6-01 형식)의 프로젝트 이름과 그 출처. 추측하지 않는다.
-- 왜: 보고서·PDF 제목은 스냅샷의 projectName을 쓴다. 보고서는 생성 시점 기록이라 「그때 이름」만 넣어야 한다.
--   그런데 DB에는 이름 변경의 커밋 시각이 남지 않는다(기록 시각은 트랜잭션 시작 시각이다).
--   (M6-02 당시 이야기다. M6 통합 뒤에는 0036 상태 이력이 커밋 순서를 남기므로, 이력이 있는 보고서는 규칙 2 첫 단계로 판단한다.)
--   그래서 이름을 바꾼 적이 있는 프로젝트는 옛 보고서의 그때 이름을 확실히 알 수 없다.
-- 스냅샷 계약: projectName(문자 또는 null) + projectNameStatus(snapshot | filled | unknown).
-- 규칙:
--   1. 이름이 있는 스냅샷(생성할 때 기록한 것)에 출처가 없으면 projectNameStatus = 'snapshot'을 붙인다.
--   2. 이름이 없는 스냅샷(M6-01 형식) — 먼저 M6-01 상태 이력(0036 state_log·0037 commit_real)으로 판단한다(M6 통합에서 추가):
--      - 스냅샷의 basis.asOf(T, 커밋 시계 값)가 있고, 이력에 T 시점 프로젝트 행이 있으면, 보고서를 만든 때의 이름은
--        「T 시점 이름」이거나 「T 이후에 커밋된 변경의 이름」 중 하나다(T ≤ 기준점 < 보고서 커밋).
--        · 그 이름들이 모두 같으면 그 이름이 확실하다. projectName = 그 이름, projectNameStatus = 'filled'.
--        · 둘 이상이면 어느 것인지 모른다. projectName = null, projectNameStatus = 'unknown'.
--        · 「T 이후」에는 아직 정리(commit_real)되지 않은 커밋과 경계가 불확실한 커밋도 넣는다. 넣는 쪽이 늘 안전하다(이름이 늘면 unknown이 될 뿐).
--        왜: 이름 변경 기록(task_history)은 트랜잭션 시작 시각이라 보고서 앞뒤를 가를 수 없지만, 이력의 커밋 순서는 가를 수 있다.
--        그래서 「이름을 바꾼 적이 있지만 보고서 기준점 뒤로는 바꾸지 않은」 프로젝트의 보고서는 이제 이름을 채울 수 있다.
--      - 이력으로 판단할 수 없으면(basis.asOf 없음, T가 이력 시작 전, 초기화로 이력이 지워짐) 아래 옛 규칙을 쓴다.
--      - 이름 변경 기록(task_history 「프로젝트 수정」, 이름이 실제로 바뀐 것)이 전혀 없는 프로젝트:
--        이름이 한 번도 바뀌지 않았으므로 지금 이름이 그때 이름이다. projectName = 지금 이름, projectNameStatus = 'filled'.
--      - 이름 변경 기록이 하나라도 있는 프로젝트: 그때 이름이 확실하지 않다.
--        projectName = null, projectNameStatus = 'unknown'. 화면·PDF는 「이름 미상(기존 보고서)」을 보인다.
--   3. 앞선 개발 판의 표시 필드(projectNameFilled)가 있으면 지운다(계약에 없는 필드).
-- 새 보고서는 생성할 때 이름과 출처(snapshot)를 넣으므로 이 마이그레이션과 관계없다.
-- 이미 출처가 있는 보고서는 건드리지 않는다. 보고서는 추가 전용이라 이 갱신 동안만 append_only 트리거를 끈다.
ALTER TABLE public.reports DISABLE TRIGGER append_only;
--> statement-breakpoint
WITH t AS (
  -- T: 스냅샷 basis.asOf(마이크로초 6자리 UTC). 형식이 아니면 이력 판단을 하지 않는다(t = null).
  SELECT x.id, x.project_id, CASE WHEN x.snapshot #>> '{basis,asOf}' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$'
    THEN (x.snapshot #>> '{basis,asOf}')::timestamptz END AS t
  FROM public.reports x WHERE NOT (x.snapshot ? 'projectNameStatus')
), anchor AS (
  -- T 시점 프로젝트 행(apps/api/src/reports/state.ts asOf와 같은 규칙: 커밋 시계 < T 이고 실제 커밋 시각(모르면 관측 시각) < T, 같은 행은 순번이 큰 것)
  SELECT t.id, a.op, a.data FROM t CROSS JOIN LATERAL (
    SELECT l.op, l.data FROM public.state_log l JOIN public.commit_real c ON c.xid = l.xid
    WHERE l.project_id = t.project_id AND l.tbl = 'projects' AND l.row_id = t.project_id
      AND c.stamp < t.t AND coalesce(c.committed_at, c.observed_at) < t.t
    ORDER BY l.seq DESC LIMIT 1
  ) a WHERE t.t IS NOT NULL
), h AS (
  SELECT t.id, count(DISTINCT n.name)::int AS names, min(n.name) AS name
  FROM t JOIN anchor ON anchor.id = t.id
  CROSS JOIN LATERAL (
    SELECT anchor.data->>'name' AS name WHERE anchor.op <> 'delete'
    UNION ALL
    -- T 이후(또는 아직 정리 전·경계 불확실)의 변경. 넣는 쪽이 안전하다.
    SELECT l.data->>'name' FROM public.state_log l LEFT JOIN public.commit_real c ON c.xid = l.xid
    WHERE l.project_id = t.project_id AND l.tbl = 'projects' AND l.row_id = t.project_id AND l.op <> 'delete'
      AND (c.xid IS NULL OR NOT (c.stamp < t.t AND coalesce(c.committed_at, c.observed_at) < t.t))
  ) n
  GROUP BY t.id
)
UPDATE public.reports r
SET snapshot = (r.snapshot - 'projectNameFilled') || CASE
  WHEN r.snapshot ? 'projectName' AND jsonb_typeof(r.snapshot->'projectName') = 'string'
    THEN jsonb_build_object('projectNameStatus', 'snapshot')
  WHEN (SELECT h.names FROM h WHERE h.id = r.id) = 1
    THEN jsonb_build_object('projectName', (SELECT h.name FROM h WHERE h.id = r.id), 'projectNameStatus', 'filled')
  WHEN (SELECT h.names FROM h WHERE h.id = r.id) > 1 THEN jsonb_build_object('projectName', NULL, 'projectNameStatus', 'unknown')
  WHEN EXISTS (
    SELECT 1 FROM public.task_history th
    WHERE th.project_id = r.project_id AND th.kind = '프로젝트 수정'
      AND th.before ? 'name' AND th.before->>'name' IS DISTINCT FROM th.after->>'name'
  ) THEN jsonb_build_object('projectName', NULL, 'projectNameStatus', 'unknown')
  ELSE jsonb_build_object('projectName', p.name, 'projectNameStatus', 'filled')
END
FROM public.projects p
WHERE p.id = r.project_id AND NOT (r.snapshot ? 'projectNameStatus');
--> statement-breakpoint
ALTER TABLE public.reports ENABLE TRIGGER append_only;
