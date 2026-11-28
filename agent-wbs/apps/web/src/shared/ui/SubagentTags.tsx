/** 시도 머리줄의 지정 · 실제 하위 Agent 태그(원본 P L1310). 문구 규칙은 shared/subagents.ts. */
import { subagentView, type AttemptSubagents } from '../subagents.ts';

export function SubagentTags({ subagents, running }: { subagents: AttemptSubagents; running: boolean }) {
  const v = subagentView(subagents, running);
  return (
    <>
      {v.designated && <span className="tag sub" title="Planning Agent가 지정하고 Runner가 실행 직전 설치한 하위 Agent">지정 {v.designated}</span>}
      {v.used && <span className={v.used.cls} title="실제 사용된 하위 Agent — 실행 중은 출력 스트림 관측(추정), 종료 후 세션 기록으로 확정">실제 {v.used.label}</span>}
      {v.missing && <span className="sc sc-warn" title="주의 표시만 — Completion Gate 조건 아님">{v.missing}</span>}
    </>
  );
}
