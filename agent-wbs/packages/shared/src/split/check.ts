import type { JudgedRule, ProposalTask, SplitException } from '../proposal/index.ts';
import { judgementOf } from './judgement.ts';
import type { JudgementState } from './judgement.ts';

// G§5.2-1 and prototype SPLIT_RULES / splitCheck.
export const SPLIT_RULES = [
  { key: 'one', label: '목적이 하나', mode: 'auto' },
  { key: 'domain', label: '주 기술 영역이 하나', mode: 'auto' },
  { key: 'size', label: '크기 상한 이내', mode: 'auto' },
  { key: 'verify', label: '혼자 검증 가능', mode: 'auto' },
  { key: 'revert', label: '혼자 되돌릴 수 있음', mode: 'judge' },
  { key: 'cg', label: '충돌 묶음이 하나', mode: 'auto' },
  { key: 'contract', label: '공유 계약 변경은 따로', mode: 'judge' },
  { key: 'irrev', label: '되돌리기 어려운 변경은 따로', mode: 'auto' },
  { key: 'refactor', label: '정리와 기능 변경은 따로', mode: 'judge' },
  { key: 'unknown', label: '불확실하면 조사부터', mode: 'auto' },
] as const;
export type SplitRule = typeof SPLIT_RULES[number]['key'];
export type SplitStatus = '통과' | '의심' | '위반' | '주의' | '판단' | '예외' | '꺼짐';

export interface SplitSettings {
  maxHours: number;
  minHours: number;
  maxFiles: number;
  enabled: Readonly<Record<SplitRule, boolean>>;
}

export const DEFAULT_SPLIT_SETTINGS: SplitSettings = {
  maxHours: 4, minHours: 0.5, maxFiles: 8,
  enabled: {
    one: true, domain: true, size: true, verify: true, revert: true, cg: true,
    contract: true, irrev: true, refactor: true, unknown: true,
  },
};

export interface SplitItem {
  rule: SplitRule;
  label: string;
  mode: 'auto' | 'judge';
  status: SplitStatus;
  detail: string;
  // Only for enabled judge rules.
  judgement: JudgementState | null;
}

export interface SplitCheck {
  items: SplitItem[];
  violations: number;
  suspicions: number;
  cautions: number;
  exceptions: number;
  // Judge rules with no valid record or `not_met`: approval waits (D-33); exceptions do not replace them.
  approvalHolds: SplitRule[];
}

const LAYER = { DB: 'DB', API: 'BE', FE: 'FE', DevOps: 'DevOps' } as const;
type Finding = readonly [SplitStatus, string];

function autoFindings(
  task: ProposalTask, preds: readonly Pick<ProposalTask, 'workType'>[], settings: SplitSettings,
): Partial<Record<SplitRule, Finding>> {
  const est = task.estimate?.est ?? 0;
  // Unlike the prototype's `||`, an optimistic estimate of 0 is a value, not a missing one.
  const lo = task.estimate?.lo ?? est;
  const hi = task.estimate?.hi ?? est;
  const changed = task.design.filter(section => section.items.length);
  const layers = [...new Set(changed.map(section => LAYER[section.kind]))];
  const dbDesign = changed.some(section => section.kind === 'DB');
  const analysed = preds.some(pred => pred.workType === 'Analysis');
  const uncertain = task.estimate?.confidence === '하' || hi / Math.max(0.1, lo) > 2.5 && hi - lo > 2;

  let size: Finding = ['통과', `예상 ${est}h ≤ ${settings.maxHours}h · 파일 ${task.files.length}개`];
  if (est > settings.maxHours) size = ['위반', `예상 ${est}h > 상한 ${settings.maxHours}h`];
  else if (task.files.length > settings.maxFiles) {
    size = ['위반', `바뀌는 파일 ${task.files.length}개 > 상한 ${settings.maxFiles}개`];
  } else if (!task.estimate) size = ['주의', '예상 실행 시간 미등록'];
  else if (est < settings.minHours) {
    size = ['주의', `예상 ${est}h < 하한 ${settings.minHours}h — 같은 목적 Task와 합치는 것 검토`];
  }

  let verify: Finding = ['통과', `AC ${task.ac.length} · 체크리스트 ${task.checklist.length}`];
  if (!task.ac.length && !task.checklist.length) {
    verify = task.status === 'planning'
      ? ['주의', '명세 작성 중 — Acceptance Criteria 작성 후 다시 점검']
      : ['위반', 'Acceptance Criteria · 체크리스트가 없어 혼자 검증할 수 없음'];
  }

  return {
    one: /( 및 |그리고| \+ |\/)/.test(task.title)
      ? ['의심', '제목에 둘 이상의 목적 표현 (「및 · 그리고 · / · +」)'] : ['통과', `「${task.title}」`],
    // G§5.2-1 has no work-type exemption; the prototype's Implementation/Configuration limit is not followed.
    domain: layers.length > 1
      ? ['의심', `설계상 변경 영역 ${layers.join(' · ')} — 계층별 분리 기준(A)`] : ['통과', `주 영역 ${task.primaryDomain}`],
    size,
    verify,
    // conflict_group is one nullable column, so two groups cannot be stored.
    cg: ['통과', task.conflictGroup ? `「${task.conflictGroup}」 하나` : '충돌 묶음 없음'],
    irrev: task.workType === 'Implementation' && task.primaryDomain !== 'DB' && dbDesign
      ? ['의심', `DB 설계(Migration)와 ${task.primaryDomain} 코드가 한 Task`]
      : ['통과', dbDesign ? 'DB 변경 전용 Task' : '되돌리기 어려운 변경 없음'],
    unknown: uncertain && !analysed
      ? ['위반', `신뢰도 ${task.estimate?.confidence ?? '-'} · 범위 ${lo}h~${hi}h — 선행 분석 Task 없음`]
      : ['통과', analysed ? '분석 Task 선행' : '추정 범위 안정'],
  };
}

export function checkSplit(
  task: ProposalTask, preds: readonly Pick<ProposalTask, 'workType'>[], subjectHash: string | null,
  settings: SplitSettings = DEFAULT_SPLIT_SETTINGS,
): SplitCheck {
  const auto = autoFindings(task, preds, settings);
  const items = SPLIT_RULES.map(({ key, label, mode }): SplitItem => {
    const item = { rule: key, label, mode, judgement: null };
    if (!settings.enabled[key]) return { ...item, status: '꺼짐', detail: '설정에서 끔' };
    const finding = auto[key];
    if (!finding) {
      const { state, detail } = judgementOf(task.judgedRules, key as JudgedRule, subjectHash);
      return { ...item, status: '판단', detail, judgement: state };
    }
    const exception = task.exceptions.find(entry => entry.rule === key);
    return exception && (finding[0] === '위반' || finding[0] === '의심')
      ? { ...item, status: '예외', detail: `${exception.why} (${exception.by})` }
      : { ...item, status: finding[0], detail: finding[1] };
  });
  const count = (status: SplitStatus) => items.filter(item => item.status === status).length;
  return {
    items, violations: count('위반'), suspicions: count('의심'), cautions: count('주의'), exceptions: count('예외'),
    approvalHolds: items.filter(item => item.judgement && item.judgement !== 'met').map(item => item.rule),
  };
}

export function flaggedRules(check: SplitCheck): SplitRule[] {
  return check.items.filter(item => item.status === '위반' || item.status === '의심').map(item => item.rule);
}

/** Initial WBS approval and settings summary: a Task counts once, violation first. */
export function summarizeSplit(checks: readonly SplitCheck[]) {
  const violations = checks.filter(check => check.violations).length;
  const suspicions = checks.filter(check => !check.violations && check.suspicions).length;
  return {
    passed: checks.length - violations - suspicions, suspicions, violations,
    exceptions: checks.reduce((sum, check) => sum + check.exceptions, 0),
    approvalHeld: checks.filter(check => check.approvalHolds.length).length,
  };
}

export function hasStarted(task: Pick<ProposalTask, 'status' | 'hasExecutionHistory'>): boolean {
  return task.hasExecutionHistory || !['planning', 'approval', 'ready'].includes(task.status);
}

/** G§5.2-1: unstarted Tasks are split, only started ones may carry a reasoned exception. */
export function splitExceptionProblem(task: ProposalTask, check: SplitCheck, exception: SplitException): string | null {
  if (!hasStarted(task)) return '시작하지 않은 Task는 분할 제안으로 처리합니다';
  if (!flaggedRules(check).some(rule => rule === exception.rule)) return '위반 · 의심인 기준만 예외로 기록할 수 있습니다';
  if (!exception.why.trim() || !exception.by.trim()) return '예외 사유와 합의 주체가 필요합니다';
  return null;
}
