import { draftSource, type DraftInput, type DraftTaskInput } from '../src/project/draft.ts';
import { subjectHash } from '../src/project/hash.ts';

/** 프로젝트 테스트가 함께 쓰는 초기 WBS 초안. 기본값은 규칙 5·7·9를 두 Agent가 모두 「충족」으로 판단한 상태다. */
export const AT = '2026-11-26T01:00:00Z';
const both = ['Claude', 'Codex'] as const;
export const met = (rule: 'revert' | 'contract' | 'refactor', hash = '0'.repeat(64)) => ({ rule, result: 'met' as const, agreedBy: [...both], basis: '근거', judgedAt: AT, sourceRef: `sha256:${hash}` });

export function task(ref: string, extra: Partial<DraftTaskInput> = {}): DraftTaskInput {
  const result: DraftTaskInput = {
    ref, wpRef: 'wp1', title: `작업 ${ref}`, workType: 'Implementation', primaryDomain: 'BE', relatedDomains: [], priority: 1,
    assigneeAgent: 'Claude', verifierAgent: 'Codex',
    estimate: { estHours: 2, loHours: 1, hiHours: 3, confidence: '중', basis: '추정 근거', agreedBy: ['Claude', 'Codex'] },
    overview: { purpose: '목적', background: '', scope: ['범위'], out: [], precond: '', doneCond: '완료 조건' },
    spec: { req: [], work: [], steps: [], inputs: [], outputs: [], files: [], constraints: [], errors: [], docs: [], verify: [] },
    ac: [{ given: 'g', when: 'w', then: 't', method: 'test' }],
    outputs: [{ name: '코드', kind: 'code', required: true, verify: 'test', delivered: false }],
    checklist: [{ content: '단위 테스트', required: true }],
    grades: { dev: { modelId: 'm', effort: 'high', reason: 'r' }, qa: { modelId: 'm', effort: 'high', reason: 'r' } },
    subagents: { dev: [], qa: [], basis: '' },
    splitBasis: '목적 하나',
    judgedRules: { schemaVersion: 1, items: [met('revert'), met('contract'), met('refactor')] },
    conflictGroup: null,
    designItems: [],
    ...extra,
  };
  if (result.judgedRules) result.judgedRules = { ...result.judgedRules, items: result.judgedRules.items.map((item) => ({ ...item, sourceRef: `sha256:${subjectHash(draftSource(result))}` })) };
  return result;
}
export function draft(tasks: DraftTaskInput[] = [task('t1'), task('t2')], deps: DraftInput['deps'] = [{ predRef: 't1', succRef: 't2', depType: 'FS' }]): DraftInput {
  return { phases: [{ ref: 'ph1', title: '1단계' }], wps: [{ ref: 'wp1', phaseRef: 'ph1', title: '묶음' }], tasks, deps };
}

