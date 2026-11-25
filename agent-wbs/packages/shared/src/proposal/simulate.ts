import { assertDependency, cancelBeforeStart, displayKey, DomainError } from '../domain/index.ts';
import type { Dependency } from '../domain/index.ts';
import { proposalImpact } from './impact.ts';
import { AGENTS, DOMAINS, WORK_TYPES } from './types.ts';
import type {
  AcceptanceCriterion, DesignKind, ModifyField, NewTask, ProposalDiff, ProposalIssue, ProposalIssueCode, ProposalOp,
  ProposalSimulation, ProposalSnapshot, ProposalTask, RemovedDependency, TechDomain,
} from './types.ts';

const DOMAIN_TO_DESIGN: Partial<Record<TechDomain, DesignKind>> = {
  DB: 'DB', BE: 'API', API: 'API', FE: 'FE', DevOps: 'DevOps',
};

export function parseAcceptanceCriterion(text: string): AcceptanceCriterion {
  const match = /^Given\s+(.+?),\s*When\s+(.+?),\s*Then\s+(.+)$/i.exec(text.trim());
  if (!match) return { given: '', when: '', then: text, method: '' };
  const [, given = '', when = '', then = ''] = match;
  return { given, when, then, method: '' };
}

const DEPENDENCY_CODES: readonly ProposalIssueCode[] =
  ['TASK_NOT_FOUND', 'DEPENDENCY_SELF', 'DEPENDENCY_DUPLICATE', 'DEPENDENCY_CYCLE'];

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validTitle = (value: unknown) => filled(value) && value.length <= 200;
const validPriority = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3;
const oneOf = (values: readonly string[], value: unknown) => values.includes(value as string);
const validAc = (ac: AcceptanceCriterion) => filled(ac.then);
const validDepType = (type: unknown) => type === 'FS' || type === 'SS';
const sameAc = (a: AcceptanceCriterion, b: AcceptanceCriterion) =>
  a.given === b.given && a.when === b.when && a.then === b.then;

function newTaskProblem(task: NewTask): string | null {
  if (!validTitle(task.title)) return '제목은 1~200자여야 합니다';
  if (!oneOf(WORK_TYPES, task.workType)) return '작업 유형이 올바르지 않습니다';
  const related = task.relatedDomains ?? [];
  if (!oneOf(DOMAINS, task.primaryDomain) || related.some(domain => !oneOf(DOMAINS, domain)) ||
    related.includes(task.primaryDomain)) return '주 · 관련 기술 영역이 올바르지 않습니다';
  if (!validPriority(task.priority)) return '우선순위는 0~3이어야 합니다';
  if (!oneOf(AGENTS, task.assignee) || !oneOf(AGENTS, task.verifier)) return '담당 · 검증 Agent가 올바르지 않습니다';
  if ((task.ac ?? []).some(ac => !validAc(ac))) return 'Acceptance Criteria가 비어 있습니다';
  if (task.estimate) {
    const { est, lo, hi } = task.estimate;
    const low = lo ?? est;
    const high = hi ?? est;
    if (![est, low, high].every(Number.isFinite) || !(low >= 0 && low <= est && est <= high && est > 0)) {
      return '추정은 낙관 ≤ 예상 ≤ 비관이어야 합니다';
    }
  }
  return null;
}

function createTask(id: string, task: NewTask): ProposalTask {
  const ac = task.ac ?? [];
  const kinds = [task.primaryDomain, ...(task.relatedDomains ?? [])].flatMap(domain => DOMAIN_TO_DESIGN[domain] ?? []);
  return {
    relatedDomains: [], purpose: '', scope: [], doneCond: '', files: [], estimate: null, conflictGroup: null,
    splitBasis: '', judgements: [], design: [...new Set(kinds)].map(kind => ({ kind, items: [] })), ...task,
    ac, id, status: 'planning', exceptions: [], hasExecutionHistory: false,
    checklist: ac.map((item, i) => ({
      id: `CL-${id.slice(5)}-${i + 1}`, text: item.then, required: true, done: false, method: item.method || '자동 테스트',
    })),
  };
}

/** The single function behind both preview and apply. A non-empty `issues` means hold; never persist `next` then. */
export function simulateProposal(base: ProposalSnapshot, ops: readonly ProposalOp[]): ProposalSimulation {
  const tasks = new Map(base.tasks.map(task => [task.id, task]));
  const phases = base.phases.map(phase => ({ ...phase, wps: phase.wps.map(wp => ({ ...wp, tasks: [...wp.tasks] })) }));
  const idMap = new Map<string, string>();
  const issues: ProposalIssue[] = [];
  const diff: ProposalDiff[] = [];
  const removed: RemovedDependency[] = [];
  let dependencies: readonly Dependency[] = base.dependencies;
  let taskSequence = base.taskSequence;

  const resolve = (ref: string) => idMap.get(ref) ?? ref;
  // An edge added and dropped inside one proposal never existed for the reader of the impact list.
  const dropped = (dep: Dependency, reason: RemovedDependency['reason']) => {
    if (base.dependencies.includes(dep)) removed.push({ ...dep, reason });
  };

  if (!ops.length) issues.push({ index: null, code: 'EMPTY_PROPOSAL', message: '변경 항목이 없습니다' });

  ops.forEach((op, index) => {
    const hold = (code: ProposalIssueCode, message: string) => {
      issues.push({ index, code, message: `항목 ${index + 1} — ${message}` });
    };
    const record = (target: string, field: string, before: unknown, after: unknown) => {
      diff.push({ index, op: op.op, target, field, before, after });
    };
    // Cancelled/done are terminal, so their specification and relations are preserved.
    const editable = (id: string, action: string): ProposalTask | null => {
      const task = tasks.get(id);
      if (!task) hold('TASK_NOT_FOUND', `${id}이(가) 없습니다`);
      else if (task.status === 'done') {
        hold('COMPLETED_TASK', `${id}은(는) 완료된 Task입니다 — ${action}할 수 없으며 수정 Task로 제안해야 합니다`);
      } else if (task.status === 'cancelled') hold('CANCELLED_TASK', `${id}은(는) 취소된 Task입니다`);
      else return task;
      return null;
    };
    const addDependency = (candidate: Dependency): boolean => {
      const { pred, succ, type } = candidate;
      if (!validDepType(type)) {
        hold('VALIDATION_FAILED', '선행 유형은 FS 또는 SS여야 합니다');
        return false;
      }
      if (tasks.get(pred)?.status === 'cancelled') {
        hold('CANCELLED_TASK', `취소된 ${pred}을(를) 선행으로 지정할 수 없습니다`);
        return false;
      }
      try {
        assertDependency([...tasks.values()], dependencies, candidate);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        const path = error.details.path as string[] | undefined;
        hold(DEPENDENCY_CODES.find(code => code === error.code) ?? 'VALIDATION_FAILED',
          `${error.message} (${pred} → ${succ})${path ? `: ${path.join(' → ')}` : ''}`);
        return false;
      }
      dependencies = [...dependencies, { pred, succ, type }];
      return true;
    };

    switch (op.op) {
      case 'add': {
        if (!filled(op.ref) || idMap.has(op.ref) || tasks.has(op.ref)) {
          hold('VALIDATION_FAILED', `신규 Task 참조 ${op.ref}가 비었거나 중복됩니다`);
          return;
        }
        const problem = newTaskProblem(op.task);
        if (problem) hold('VALIDATION_FAILED', problem);
        const wp = phases.flatMap(phase => phase.wps).find(item => item.id === op.workPackageId);
        if (!wp) hold('WBS_NODE_NOT_FOUND', `Work Package ${op.workPackageId}이(가) 없습니다`);
        // Keep going after an issue, like the original, so later ops do not produce cascading errors.
        taskSequence += 1;
        const id = displayKey('TASK', taskSequence);
        if (tasks.has(id)) {
          hold('VALIDATION_FAILED', `Task 순번 ${id}이(가) 이미 사용되었습니다`);
          return;
        }
        idMap.set(op.ref, id);
        tasks.set(id, createTask(id, op.task));
        wp?.tasks.push(id);
        const preds = (op.preds ?? []).map(pred => ({ pred: resolve(pred.pred), type: pred.type }));
        preds.forEach(pred => addDependency({ ...pred, succ: id }));
        record(id, 'task', null, { workPackageId: op.workPackageId, ...op.task, preds });
        return;
      }
      case 'modify': {
        const id = resolve(op.task);
        const task = editable(id, '수정');
        if (!task) return;
        const change = modifyTask(task, op.field, op.after);
        if ('code' in change) hold(change.code, `${id} ${op.field}: ${change.message}`);
        else {
          tasks.set(id, change.task);
          record(id, op.field, change.before, op.after);
        }
        return;
      }
      case 'remove': {
        const id = resolve(op.task);
        const task = tasks.get(id);
        if (task?.status === 'cancelled') return hold('ALREADY_APPLIED', `${id}은(는) 이미 취소되었습니다`);
        if (!editable(id, '삭제') || !task) return;
        if (task.hasExecutionHistory || !['planning', 'approval', 'ready'].includes(task.status)) {
          return hold('EXECUTION_HISTORY', `${id}에는 실행 이력이 있어 취소할 수 없습니다`);
        }
        const result = cancelBeforeStart([...tasks.values()], dependencies, id, task.hasExecutionHistory);
        tasks.set(id, { ...task, status: 'cancelled' });
        result.removedDependencies.forEach(dep => dropped(dep, dep.pred === id ? 'pred-cancelled' : 'succ-cancelled'));
        dependencies = result.dependencies;
        record(id, 'status', task.status, 'cancelled');
        return;
      }
      case 'dep-add': {
        const pred = resolve(op.pred);
        const succ = resolve(op.succ);
        const type = op.type ?? 'FS';
        // A relation belongs to its successor (contracts §1.3), so a done successor is a completed-Task edit.
        if (tasks.has(pred) && !editable(succ, '선행을 추가')) return;
        if (addDependency({ pred, succ, type })) record(succ, 'dependency', null, { pred, type });
        return;
      }
      case 'dep-remove': {
        const pred = resolve(op.pred);
        const succ = resolve(op.succ);
        const target = dependencies.find(dep => dep.pred === pred && dep.succ === succ);
        if (!target) return hold('DEPENDENCY_NOT_FOUND', `${pred} → ${succ} 관계가 없습니다`);
        if (!editable(succ, '선행을 삭제')) return;
        dependencies = dependencies.filter(dep => dep !== target);
        dropped(target, 'dep-remove');
        record(succ, 'dependency', { pred, type: target.type }, null);
        return;
      }
      default:
        hold('VALIDATION_FAILED', `알 수 없는 변경 유형 ${String((op as { op: unknown }).op)}`);
    }
  });

  const next: ProposalSnapshot = { phases, tasks: [...tasks.values()], dependencies, taskSequence };
  return { next, idMap: Object.fromEntries(idMap), issues, diff, impact: proposalImpact(base, next, diff, removed) };
}

function modifyTask(task: ProposalTask, field: ModifyField, after: string | number | AcceptanceCriterion):
  { task: ProposalTask; before: unknown } | { code: ProposalIssueCode; message: string } {
  const invalid = { code: 'VALIDATION_FAILED', message: '변경 값이 올바르지 않습니다' } as const;
  const applied = { code: 'ALREADY_APPLIED', message: '이미 적용된 변경입니다' } as const;
  switch (field) {
    case 'priority':
      if (!validPriority(after)) return invalid;
      break;
    case 'title':
      if (!validTitle(after)) return invalid;
      break;
    case 'doneCond':
      if (!filled(after)) return invalid;
      break;
    case 'assignee':
    case 'verifier':
      if (!oneOf(AGENTS, after)) return invalid;
      break;
    case 'scopeAdd':
      if (!filled(after)) return invalid;
      return task.scope.includes(after) ? applied : { task: { ...task, scope: [...task.scope, after] }, before: null };
    case 'acAdd': {
      if (typeof after === 'number') return invalid;
      const ac = typeof after === 'string' ? parseAcceptanceCriterion(after) : after;
      if (!validAc(ac)) return invalid;
      return task.ac.some(item => sameAc(item, ac)) ? applied : { task: { ...task, ac: [...task.ac, ac] }, before: null };
    }
    default:
      // G§5.6 is closed: in particular a proposal must not write `status`.
      return { code: 'VALIDATION_FAILED', message: '변경할 수 없는 항목입니다' };
  }
  if (task[field] === after) return applied;
  return { task: { ...task, [field]: after }, before: task[field] };
}

/** Key-order-independent text of what the reviewer saw; M2-07 hashes it into `previewHash`. */
export function canonicalPreview({ idMap, issues, diff, impact }: ProposalSimulation): string {
  return JSON.stringify({ idMap, issues, diff, impact }, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value);
}
