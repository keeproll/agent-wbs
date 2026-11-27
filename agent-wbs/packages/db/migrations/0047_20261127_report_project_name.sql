-- M6-02(Codex 리뷰 P2): 이름 없는 옛 보고서 스냅샷(M6-01 형식)에 생성 시점 프로젝트 이름을 채운다.
-- 왜: 보고서·PDF 제목은 스냅샷의 projectName을 쓴다. 보고서는 생성 시점 기록이라 「그때 이름」이어야 한다.
-- 그때 이름 찾기: 보고서 생성 뒤 첫 「프로젝트 수정」 기록의 before.name. 생성 뒤 이름 변경 기록이 없으면 지금 이름이 그때 이름이다.
-- 채웠다는 표시: projectNameFilled.source = 'history'(변경 기록에서 찾음) | 'current'(변경이 없어 지금 이름).
-- 이미 projectName이 있는 보고서는 건드리지 않는다. 보고서는 추가 전용이라 이 갱신 동안만 append_only 트리거를 끈다.
ALTER TABLE public.reports DISABLE TRIGGER append_only;
--> statement-breakpoint
WITH fill AS (
  SELECT r.id,
    coalesce(h.name, p.name) AS name,
    CASE WHEN h.name IS NULL THEN 'current' ELSE 'history' END AS source
  FROM public.reports r
  JOIN public.projects p ON p.id = r.project_id
  LEFT JOIN LATERAL (
    SELECT th.before->>'name' AS name
    FROM public.task_history th
    WHERE th.project_id = r.project_id AND th.kind = '프로젝트 수정' AND th.created_at > r.generated_at
      AND th.before ? 'name' AND th.before->>'name' IS DISTINCT FROM th.after->>'name'
    ORDER BY th.created_at, th.id
    LIMIT 1
  ) h ON true
  WHERE NOT (r.snapshot ? 'projectName')
)
UPDATE public.reports r
SET snapshot = r.snapshot || jsonb_build_object('projectName', f.name, 'projectNameFilled', jsonb_build_object('source', f.source))
FROM fill f
WHERE f.id = r.id;
--> statement-breakpoint
ALTER TABLE public.reports ENABLE TRIGGER append_only;
