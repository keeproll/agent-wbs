import { parseDocument } from 'yaml';

const TASK_STEPS = ['install', 'typecheck', 'lint', 'unit', 'build', 'contract'] as const;
const STAGES = ['task', 'int', 'night', 'deploy'] as const;
export interface PipelineStep {
  name: string; argv: [string, ...string[]];
  /** ③ night 단계에만 쓰는 선택 필드. 주요 API 이름 → p95 기준(ms). main에 고정된 정의에서만 읽는다. */
  budgetsMs?: Record<string, number>;
}
const MAX_BUDGET_MS = 600_000;
export interface Pipeline { version: 1; stages: Record<typeof STAGES[number], PipelineStep[]> }

function invalid(): never { throw new TypeError('pipeline.yaml 스키마가 올바르지 않습니다.'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}

/** main의 정의만 받는다. shell 문자열 대신 명령과 인자를 나눈 argv 배열을 쓴다. */
export function parsePipeline(source: string): Pipeline {
  if (Buffer.byteLength(source) > 256 * 1024) return invalid();
  const document = parseDocument(source, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, stringKeys: true });
  if (document.errors.length || document.warnings.length) return invalid();
  const root = object(document.toJS({ maxAliasCount: 0 }) as unknown, ['version', 'stages']);
  if (root.version !== 1) return invalid();
  const stages = object(root.stages, STAGES);
  const readSteps = (value: unknown, budgets = false): PipelineStep[] => {
    if (!Array.isArray(value) || value.length === 0) return invalid();
    const names = new Set<string>();
    return value.map((entry: unknown) => {
      const withBudgets = budgets && Boolean(entry) && typeof entry === 'object' && Object.hasOwn(entry as object, 'budgetsMs');
      const step = object(entry, withBudgets ? ['name', 'argv', 'budgetsMs'] : ['name', 'argv']);
      if (typeof step.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(step.name) || names.has(step.name)) return invalid();
      names.add(step.name);
      if (!Array.isArray(step.argv) || step.argv.length === 0 ||
        step.argv.some((arg: unknown) => typeof arg !== 'string' || arg.includes('\0')) ||
        typeof step.argv[0] !== 'string' || step.argv[0].trim() === '') return invalid();
      if (!withBudgets) return { name: step.name, argv: step.argv as [string, ...string[]] };
      const value = step.budgetsMs;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0 ||
        Object.entries(value).some(([api, ms]) => api.trim() === '' || api.length > 200 || !Number.isSafeInteger(ms) || (ms as number) < 1 || (ms as number) > MAX_BUDGET_MS)) return invalid();
      return { name: step.name, argv: step.argv as [string, ...string[]], budgetsMs: Object.fromEntries(Object.entries(value as Record<string, number>)) };
    });
  };
  const task = readSteps(stages.task);
  if (task.length !== TASK_STEPS.length || task.some((step, index) => step.name !== TASK_STEPS[index])) return invalid();
  return { version: 1, stages: { task, int: readSteps(stages.int), night: readSteps(stages.night, true), deploy: readSteps(stages.deploy) } };
}
