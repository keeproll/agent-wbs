-- M6-02(Codex 리뷰 P2, 재리뷰 P2-2): 이름 없는 옛 보고서 스냅샷(M6-01 형식)에 생성 시점 프로젝트 이름을 채운다.
-- 왜: 보고서·PDF 제목은 스냅샷의 projectName을 쓴다. 보고서는 생성 시점 기록이라 「그때 이름」이어야 한다.
--
-- 기준 시각 G = 보고서 생성 시각(reports.generated_at).
-- 이름 변경 기록(task_history 「프로젝트 수정」, 이름이 실제로 바뀐 것)마다 「G 뒤의 변경인가」를 아래 근거 중 하나로 판정한다.
--   1. 변경 트랜잭션이 G보다 늦게 시작했다(created_at > G). created_at은 트랜잭션 시작 시각(now())이다.
--   2. 변경 알림(change_events topic=project, 같은 at)의 순번이 보고서 알림(topic=report, ref.id)보다 크다. 순번은 커밋 순서다.
--   3. 변경 기록을 쓴 트랜잭션이 보고서 행을 쓴 트랜잭션보다 새것이다(age(xmin)이 더 작다). 보고서를 저장한 뒤에 이름을 썼다는 뜻이다.
--      왜 필요한가: 편집 트랜잭션이 먼저 시작하면 기록 시각(시작 시각)은 G보다 이르지만, 실제로 이름을 바꾼 것은 보고서 저장 뒤일 수 있다(리뷰어 재현).
--      얼린(frozen) 행은 xmin을 알 수 없으므로 이 근거를 쓰지 않는다.
-- 그때 이름 = G 뒤의 변경 가운데 가장 이른 트랜잭션의 첫 변경이 바꾸기 전 이름. 그런 변경이 없으면 지금 이름.
--   - 한 트랜잭션 안의 여러 변경은 시각이 같다. 그래서 이름 사슬(before → after)로 첫 변경을 찾는다:
--     같은 트랜잭션의 다른 변경이 만든 이름(after)에서 시작하지 않는 변경이 첫 변경이다.
-- 채웠다는 표시: projectNameFilled.source = 'history'(변경 기록에서 찾음) | 'current'(G 뒤 변경이 없어 지금 이름).
-- 한계(저장된 자료로는 알 수 없음): 보고서 행보다 먼저 쓰였지만 G 뒤에 커밋한 변경은, 알림 순번이 남아 있지 않으면 「G 전 변경」으로 본다.
--   커밋 시각은 DB에 남지 않는다. 변경 알림은 7일 보존이다.
-- 이미 projectName이 있는 보고서는 건드리지 않는다. 보고서는 추가 전용이라 이 갱신 동안만 append_only 트리거를 끈다.
ALTER TABLE public.reports DISABLE TRIGGER append_only;
--> statement-breakpoint
DO $$
DECLARE
  r record;
  first_after record;
  head_name text;
BEGIN
  FOR r IN
    SELECT rp.id, rp.project_id, rp.generated_at, rp.xmin::text AS x, age(rp.xmin) AS a, p.name AS current_name,
      (SELECT min(e.seq) FROM public.change_events e WHERE e.project_id = rp.project_id AND e.topic = 'report' AND e.ref->>'id' = rp.id::text) AS report_seq
    FROM public.reports rp JOIN public.projects p ON p.id = rp.project_id
    WHERE NOT (rp.snapshot ? 'projectName')
  LOOP
    -- G 뒤의 변경 트랜잭션 가운데 가장 이른 것(트랜잭션 = 같은 xmin·같은 기록 시각).
    SELECT h.x, h.created_at INTO first_after
    FROM (
      SELECT th.xmin::text AS x, age(th.xmin) AS a, th.created_at,
        (SELECT min(e.seq) FROM public.change_events e WHERE e.project_id = th.project_id AND e.topic = 'project' AND e.at = th.created_at) AS seq
      FROM public.task_history th
      WHERE th.project_id = r.project_id AND th.kind = '프로젝트 수정'
        AND th.before ? 'name' AND th.before->>'name' IS DISTINCT FROM th.after->>'name'
    ) h
    WHERE h.created_at > r.generated_at
       OR (h.seq IS NOT NULL AND r.report_seq IS NOT NULL AND h.seq > r.report_seq)
       OR (h.x <> '2' AND r.x <> '2' AND h.x <> r.x AND h.a < r.a)
    ORDER BY h.created_at, h.a DESC
    LIMIT 1;

    IF first_after IS NULL THEN
      UPDATE public.reports SET snapshot = snapshot || jsonb_build_object('projectName', r.current_name, 'projectNameFilled', jsonb_build_object('source', 'current'))
      WHERE id = r.id;
    ELSE
      -- 그 트랜잭션의 첫 변경: 같은 트랜잭션의 다른 변경이 만든 이름에서 시작하지 않는 변경(이름 사슬의 머리).
      SELECT th.before->>'name' INTO head_name
      FROM public.task_history th
      WHERE th.project_id = r.project_id AND th.kind = '프로젝트 수정' AND th.xmin::text = first_after.x AND th.created_at = first_after.created_at
        AND th.before ? 'name' AND th.before->>'name' IS DISTINCT FROM th.after->>'name'
        AND NOT EXISTS (
          SELECT 1 FROM public.task_history o
          WHERE o.project_id = th.project_id AND o.kind = '프로젝트 수정' AND o.xmin::text = first_after.x AND o.created_at = first_after.created_at
            AND o.id <> th.id AND o.after->>'name' = th.before->>'name'
        )
      ORDER BY th.id
      LIMIT 1;
      UPDATE public.reports SET snapshot = snapshot || jsonb_build_object('projectName', head_name, 'projectNameFilled', jsonb_build_object('source', 'history'))
      WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE public.reports ENABLE TRIGGER append_only;
