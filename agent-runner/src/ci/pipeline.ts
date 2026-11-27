import { parseDocument } from 'yaml';

const TASK_STEPS = ['install', 'typecheck', 'lint', 'unit', 'build', 'contract'] as const;
const STAGES = ['task', 'int', 'night', 'deploy'] as const;
export interface PipelineStep {
  name: string; argv: [string, ...string[]];
  /** ③ night 단계에만 쓰는 선택 필드. 주요 API 이름 → p95 기준(ms). main에 고정된 정의에서만 읽는다. */
  budgetsMs?: Record<string, number>;
  /**
   * ③ night 단계에만 쓰는 선택 필드. 화면 이름 → 기준 화면을 여는 방법(조정자 결정 8·13).
   * page: main의 `prototype/uiux/` 아래 HTML, route: 화면을 여는 `#조각`(필수), ready: 화면 준비가 끝났음을 알리는 CSS 선택자.
   */
  screens?: Record<string, ScreenTarget>;
}
const MAX_BUDGET_MS = 600_000;
export interface ScreenTarget { page: string; route: string; ready: string }
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
      const extras = budgets && Boolean(entry) && typeof entry === 'object' ? ['budgetsMs', 'screens'].filter(k => Object.hasOwn(entry as object, k)) : [];
      const step = object(entry, ['name', 'argv', ...extras]);
      if (typeof step.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(step.name) || names.has(step.name)) return invalid();
      names.add(step.name);
      if (!Array.isArray(step.argv) || step.argv.length === 0 ||
        step.argv.some((arg: unknown) => typeof arg !== 'string' || arg.includes('\0')) ||
        typeof step.argv[0] !== 'string' || step.argv[0].trim() === '') return invalid();
      const result: PipelineStep = { name: step.name, argv: step.argv as [string, ...string[]] };
      const table = (value: unknown, valid: (key: string, item: unknown) => boolean) => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0 ||
          Object.entries(value).some(([key, item]) => key.trim() === '' || key.length > 200 || !valid(key, item))) return invalid();
        return Object.fromEntries(Object.entries(value)) as Record<string, never>;
      };
      if (extras.includes('budgetsMs')) result.budgetsMs = table(step.budgetsMs, (_, ms) => Number.isSafeInteger(ms) && (ms as number) >= 1 && (ms as number) <= MAX_BUDGET_MS);
      // 기준은 팀장만 바꾸는 보호 경로(prototype/uiux/)의 HTML이다. Runner가 직접 렌더한다(조정자 결정 8).
      // 왜: Agent가 기준을 자기 화면으로 바꾸지 못하게 한다. 커밋한 PNG는 요구하지 않는다.
      // 화면은 경로+#라우트로 열 수 있어야 한다. 라우트가 없는 화면은 여기서 거부한다(결정 13).
      if (extras.includes('screens')) result.screens = table(step.screens, (_, target) => {
        if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
        const { page, route, ready } = target as Record<string, unknown>;
        return Object.keys(target).length === 3 && typeof page === 'string' && typeof route === 'string' && typeof ready === 'string' &&
          /^prototype\/uiux\/[^#?\0]+\.html$/.test(page) && !page.split('/').some(part => ['', '.', '..'].includes(part)) &&
          /^#[^#\s]+$/.test(route) && ready.trim() !== '' && ready.length <= 200 && !/[\0\r\n]/.test(ready);
      });
      return result;
    });
  };
  const task = readSteps(stages.task);
  if (task.length !== TASK_STEPS.length || task.some((step, index) => step.name !== TASK_STEPS[index])) return invalid();
  return { version: 1, stages: { task, int: readSteps(stages.int), night: readSteps(stages.night, true), deploy: readSteps(stages.deploy) } };
}
