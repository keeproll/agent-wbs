import { parseDocument } from 'yaml';

const TASK_STEPS = ['install', 'typecheck', 'lint', 'unit', 'build', 'contract'] as const;
const STAGES = ['task', 'int', 'night', 'deploy'] as const;
export interface PipelineStep {
  name: string; argv: [string, ...string[]];
  /** ③ night 단계에만 쓰는 선택 필드. 주요 API 이름 → p95 기준(ms). main에 고정된 정의에서만 읽는다. */
  budgetsMs?: Record<string, number>;
  /**
   * ③ night 단계에만 쓰는 선택 필드. 화면 이름 → 기준 화면을 여는 방법(조정자 결정 8·13).
   * page: main의 `prototype/uiux/` 아래 HTML, route: 화면을 여는 `#조각`(선택), steps: 화면까지 가는 제한된 조작(선택),
   * ready: 화면 준비가 끝났음을 알리는 CSS 선택자(필수).
   */
  screens?: Record<string, ScreenTarget>;
}
const MAX_BUDGET_MS = 600_000;
/** 기준 화면까지 가는 제한된 조작. 이 세 가지만 허용한다. 임의 JS 실행은 받지 않는다(결정 13 보완). */
export type ScreenStep = { click: string } | { waitFor: string } | { setViewport: { width: number; height: number } };
export interface ScreenTarget { page: string; route?: string; ready: string; steps?: ScreenStep[] }
const MAX_SCREEN_STEPS = 20;
const selector = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 200 && !/[\0\r\n]/.test(value);
function screenStep(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return false;
  const [[kind, arg]] = Object.entries(value) as [[string, unknown]];
  if (kind === 'click' || kind === 'waitFor') return selector(arg);
  if (kind !== 'setViewport' || !arg || typeof arg !== 'object' || Array.isArray(arg) || Object.keys(arg).length !== 2) return false;
  const { width, height } = arg as Record<string, unknown>;
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && (width as number) >= 320 && (width as number) <= 3840 && (height as number) >= 240 && (height as number) <= 2160;
}
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
      // 화면은 경로로 열고, 필요하면 #라우트나 제한된 조작으로 찾아간다(결정 13과 보완). 그 밖의 필드는 거부한다.
      if (extras.includes('screens')) result.screens = table(step.screens, (_, target) => {
        if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
        const { page, route, ready, steps } = target as Record<string, unknown>;
        return Object.keys(target).every(k => ['page', 'route', 'ready', 'steps'].includes(k)) && typeof page === 'string' &&
          /^prototype\/uiux\/[^#?\0]+\.html$/.test(page) && !page.split('/').some(part => ['', '.', '..'].includes(part)) &&
          (route === undefined || typeof route === 'string' && /^#[^#\s]+$/.test(route)) && selector(ready) &&
          (steps === undefined || Array.isArray(steps) && steps.length >= 1 && steps.length <= MAX_SCREEN_STEPS && steps.every(screenStep));
      });
      return result;
    });
  };
  const task = readSteps(stages.task);
  if (task.length !== TASK_STEPS.length || task.some((step, index) => step.name !== TASK_STEPS[index])) return invalid();
  return { version: 1, stages: { task, int: readSteps(stages.int), night: readSteps(stages.night, true), deploy: readSteps(stages.deploy) } };
}
