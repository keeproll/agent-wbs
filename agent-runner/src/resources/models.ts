import type { Agent } from '../api/generated/client.ts';
import type { ApiRequest } from '../api/client.ts';
import type { RunCommand } from '../readiness/command.ts';

/** POST /runner/models 본문 */
export type ModelsReport = ApiRequest<'reportModels'>['body'];
export type ModelEntry = ModelsReport['models'][number];

/**
 * 모델 ID와 Effort 값은 CLI가 알려 준 그대로 보낸다. 코드에 모델 ID를 적지 않는다(G §9.3-1).
 * 공통 단계(1~5) 매핑·ultra 제외·미확인 처리는 서버의 owner 승인표(Q-06)가 한다(contracts §3.1).
 * rank는 「높을수록 위 등급」(shared grade `escalate`가 rank가 큰 모델로 상향한다).
 *
 * **owner 결정(2026-11-26 아이템 8)**: rank는 서버가 가진 설정값이고 팀장이 바꿀 수 있다. Runner는 그 초기값으로 보고만 한다.
 * - CLI 목록의 표시 순서(priority)는 rank로 쓰지 않는다.
 * - Codex 초기값: 세대가 높을수록 위(5.6 < 6 < 6.1 < 6.2), 같은 세대는 luna < terra < astra < sol.
 * - Claude 초기값: Q-06 승인표의 모델, Haiku 5.5 < Sonnet 5.5 < Opus 5.5 < Fable 5.2.
 * 설정 `rankOrder`(앞이 위)를 주면 그 순서가 우선한다.
 */

/** Runner 모델 보고의 초기 설정값. 바꾸려면 설정으로 덮어쓴다(코드의 판단 규칙이 아니다). */
export const DEFAULT_MODEL_SETTINGS = {
  /** Q-06 승인표의 Claude 모델, 위 등급부터. 표에 없는 새 모델은 서버가 「미허용」으로만 등록한다. */
  claudeModelIds: ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  /** 같은 세대 안 Codex 계열 순서, 아래 등급부터 */
  codexFamilyOrder: ['luna', 'terra', 'astra', 'sol'],
} as const;

/**
 * Codex 모델 ID를 위 등급부터 줄 세운다. 이름 `gpt-<세대>[-<계열>]`을 읽는다.
 * 계열이 없거나 모르는 계열은 그 세대의 맨 아래, 세대를 읽을 수 없는 이름은 전체 맨 아래(들어온 순서 유지)에 둔다[결정].
 */
export function codexRankOrder(ids: readonly string[], familyOrder: readonly string[] = DEFAULT_MODEL_SETTINGS.codexFamilyOrder): string[] {
  const keyOf = (id: string) => {
    const m = /^gpt-(\d+(?:\.\d+)*)(?:-([a-z]+))?/.exec(id);
    if (!m?.[1]) return null;
    return { gen: m[1].split('.').map(Number), family: m[2] ? familyOrder.indexOf(m[2]) : -1 };
  };
  const cmp = (a: string, b: string): number => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (!ka || !kb) return (ka ? 0 : 1) - (kb ? 0 : 1);
    for (let i = 0; i < Math.max(ka.gen.length, kb.gen.length); i += 1) {
      const d = (kb.gen[i] ?? 0) - (ka.gen[i] ?? 0);
      if (d !== 0) return d;
    }
    return kb.family - ka.family;
  };
  return [...ids].sort(cmp);
}

/** rankOrder에 적힌 모델을 그 순서대로 앞에, 나머지는 원래 순서대로 뒤에 둔다. */
function orderBy<T extends { id: string }>(items: T[], rankOrder: readonly string[] | undefined): T[] {
  if (!rankOrder?.length) return items;
  const pos = new Map(rankOrder.map((id, i) => [id, i]));
  return [...items].sort((a, b) => (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

const withRanks = (items: Omit<ModelEntry, 'rank'>[]): ModelEntry[] => items.map((m, i) => ({ ...m, rank: items.length - i }));

interface CodexModel {
  slug: string;
  display_name?: string;
  visibility?: string;
  supported_reasoning_levels?: { effort?: unknown }[];
}

const uniqueStrings = (values: unknown[]): string[] => [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== ''))];

/** `codex debug models --bundled` JSON. 목록에 보이는(`visibility: list`) 모델만 보낸다. rank는 위 규칙(설정)을 따른다. */
export function parseCodexCatalog(
  text: string,
  { rankOrder, familyOrder }: { rankOrder?: readonly string[] | undefined; familyOrder?: readonly string[] | undefined } = {},
): ModelEntry[] {
  const data = JSON.parse(text) as { models?: unknown };
  if (!Array.isArray(data.models)) throw new Error('Codex 모델 목록 형식이 아닙니다(models 없음).');
  const models = data.models as CodexModel[];
  for (const m of models) {
    if (typeof m.slug !== 'string' || m.slug === '') throw new Error('Codex 모델 목록 형식이 아닙니다(slug 없음).');
  }
  const listed = models.filter((m) => m.visibility === 'list');
  const entries = listed.map((m) => {
    const efforts = uniqueStrings((m.supported_reasoning_levels ?? []).map((l) => l.effort));
    return { id: m.slug, label: m.display_name || m.slug, efforts: efforts.length ? efforts : null };
  });
  const order = rankOrder?.length ? rankOrder : codexRankOrder(entries.map((e) => e.id), familyOrder);
  return withRanks(orderBy(entries, order));
}

/** `claude --help`의 `--effort <level> … (low, medium, …)`. 설명이 다음 줄로 넘어가도 다음 옵션 전까지 읽는다. */
export function parseClaudeEfforts(help: string): string[] | null {
  const lines = help.split('\n');
  const start = lines.findIndex((l) => /^\s*--effort\b/.test(l));
  if (start < 0) return null;
  let block = lines[start] ?? '';
  for (const line of lines.slice(start + 1)) {
    if (/^\s*-/.test(line)) break;
    block += ` ${line.trim()}`;
  }
  const inner = /\(([^)]*)\)/.exec(block)?.[1];
  const values = uniqueStrings((inner ?? '').split(',').map((v) => v.trim()));
  return values.length ? values : null;
}

/**
 * Claude 모델 목록은 설정값(owner 결정: Q-06 승인표의 모델이 초기값)이다. 앞일수록 위 등급이며
 * 도움말의 Effort 값과 함께 보낸다. CLI에서 모델별 지원은 확인할 수 없다(Q-06 「CLI에서 모델별 동작은 미확인」).
 */
export function claudeModels(ids: readonly string[], efforts: string[] | null, rankOrder?: readonly string[]): ModelEntry[] {
  const list = uniqueStrings(ids.map((id) => id.trim())).map((id) => ({ id, label: id, efforts }));
  return withRanks(orderBy(list, rankOrder));
}

export interface ModelProbe {
  run: RunCommand;
  codex: string;
  claude: string;
  /** Claude 모델 ID(앞일수록 위 등급). 없으면 `DEFAULT_MODEL_SETTINGS.claudeModelIds`. 빈 배열이면 보고하지 않는다. */
  claudeModelIds?: readonly string[];
  /** Agent별 등급 순서(앞이 위). 없으면 초기 설정 규칙. */
  rankOrder?: Partial<Record<Agent, readonly string[]>>;
  /** Codex 같은 세대 안 계열 순서(아래부터). 없으면 초기 설정값. */
  codexFamilyOrder?: readonly string[];
  /**
   * Claude Effort 출처. `help`(잠정 기본값): 도움말의 값을 모든 설정 모델에 붙인다.
   * `unknown`: 모델별 지원을 확인하지 못했으므로 null(미확인)로 보낸다.
   */
  claudeEfforts?: 'help' | 'unknown';
}

/** 보고할 본문. 확인하지 못했으면 null — 빈 목록을 보내 이미 등록된 모델을 흔들지 않는다. */
export async function collectModels(agent: Agent, p: ModelProbe): Promise<ModelsReport | null> {
  if (agent === 'Codex') {
    const r = await p.run(p.codex, ['debug', 'models', '--bundled']);
    if (r.code !== 0) return null;
    const models = parseCodexCatalog(r.stdout, { rankOrder: p.rankOrder?.Codex, familyOrder: p.codexFamilyOrder });
    return models.length ? { agent, models } : null;
  }
  const ids = p.claudeModelIds ?? DEFAULT_MODEL_SETTINGS.claudeModelIds;
  if (ids.every((id) => id.trim() === '')) return null;
  if (p.claudeEfforts === 'unknown') return { agent, models: claudeModels(ids, null, p.rankOrder?.Claude) };
  const r = await p.run(p.claude, ['--help']);
  if (r.code !== 0) return null;
  return { agent, models: claudeModels(ids, parseClaudeEfforts(r.stdout), p.rankOrder?.Claude) };
}
