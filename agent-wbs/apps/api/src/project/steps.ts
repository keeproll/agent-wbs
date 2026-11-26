/** 초기 분석 9단계(P L4488). tech·approve는 팀장이 끝내는 단계다. */
export const BOOT_STEPS = ['check', 'unzip', 'repo', 'codex', 'claude', 'cross', 'tech', 'draft', 'approve'] as const;
/** 차이 분석 5단계(P L4490) */
export const INPUT_STEPS = ['check', 'unzip', 'diff', 'impact', 'cp'] as const;
/** 재분석은 Codex 독립 분석부터 다시 한다(G§4.2, P reBoot L4550). 확정된 기술 결정은 유지한다. */
export const RERUN_STEPS = ['codex', 'claude', 'cross', 'draft', 'approve'] as const;
/** Runner가 진행을 보고할 수 없는 단계: 기술 결정 확정과 초기 WBS 승인은 팀장만 끝낸다. */
export const LEAD_STEPS = new Set<string>(['tech', 'approve']);

export type StepStatus = 'wait' | 'run' | 'done' | 'fail';
export type BootPhase = 'analyzing' | 'tech_wait' | 'drafting' | 'approval_wait';

/**
 * data-model §3.4의 boot 하위 상태는 따로 저장하지 않고 단계 진행에서 계산한다.
 * 저장하면 단계와 어긋날 수 있기 때문이다.
 */
export function bootPhase(steps: readonly { key: string; status: StepStatus }[]): BootPhase {
  const status = (key: string) => steps.find((step) => step.key === key)?.status ?? 'wait';
  if (status('draft') === 'done') return 'approval_wait';
  if (status('tech') === 'done') return 'drafting';
  if (status('cross') === 'done') return 'tech_wait';
  return 'analyzing';
}
