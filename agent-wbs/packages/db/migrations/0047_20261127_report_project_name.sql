-- M6-02(Codex 리뷰 P2, 재리뷰 3·4차 P2-2): 옛 보고서 스냅샷(M6-01 형식)의 프로젝트 이름과 그 출처. 추측하지 않는다.
-- 왜: 보고서·PDF 제목은 스냅샷의 projectName을 쓴다. 보고서는 생성 시점 기록이라 「그때 이름」만 넣어야 한다.
--   그런데 DB에는 이름 변경의 커밋 시각이 남지 않는다(기록 시각은 트랜잭션 시작 시각이다).
--   그래서 이름을 바꾼 적이 있는 프로젝트는 옛 보고서의 그때 이름을 확실히 알 수 없다.
-- 스냅샷 계약: projectName(문자 또는 null) + projectNameStatus(snapshot | filled | unknown).
-- 규칙:
--   1. 이름이 있는 스냅샷(생성할 때 기록한 것)에 출처가 없으면 projectNameStatus = 'snapshot'을 붙인다.
--   2. 이름이 없는 스냅샷(M6-01 형식):
--      - 이름 변경 기록(task_history 「프로젝트 수정」, 이름이 실제로 바뀐 것)이 전혀 없는 프로젝트:
--        이름이 한 번도 바뀌지 않았으므로 지금 이름이 그때 이름이다. projectName = 지금 이름, projectNameStatus = 'filled'.
--      - 이름 변경 기록이 하나라도 있는 프로젝트: 그때 이름이 확실하지 않다.
--        projectName = null, projectNameStatus = 'unknown'. 화면·PDF는 「이름 미상(기존 보고서)」을 보인다.
--   3. 앞선 개발 판의 표시 필드(projectNameFilled)가 있으면 지운다(계약에 없는 필드).
-- 새 보고서는 생성할 때 이름과 출처(snapshot)를 넣으므로 이 마이그레이션과 관계없다.
-- 이미 출처가 있는 보고서는 건드리지 않는다. 보고서는 추가 전용이라 이 갱신 동안만 append_only 트리거를 끈다.
ALTER TABLE public.reports DISABLE TRIGGER append_only;
--> statement-breakpoint
UPDATE public.reports r
SET snapshot = (r.snapshot - 'projectNameFilled') || CASE
  WHEN r.snapshot ? 'projectName' AND jsonb_typeof(r.snapshot->'projectName') = 'string'
    THEN jsonb_build_object('projectNameStatus', 'snapshot')
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
