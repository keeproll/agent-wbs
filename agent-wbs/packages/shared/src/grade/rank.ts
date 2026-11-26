import type { Agent } from '../vocabulary.ts';

/**
 * 모델 순서(rank)와 Claude 모델 목록의 초기 설정값(owner 결정 2026-11-26 아이템 8).
 * - rank는 서버가 가진 설정값이고 팀장이 바꿀 수 있다. Runner는 모델을 보고만 한다.
 * - CLI 목록의 표시 순서는 rank로 쓰지 않는다.
 * - 목록은 모두 「아래 등급부터」 적는다. rank는 아래부터 1, 2, …이고 클수록 위 등급이다(`escalate`와 같은 방향).
 * DB system seed(`public.default_model_settings()`)는 이 값과 같아야 한다(packages/db 테스트가 대조).
 */
export interface ModelSettings {
  rankOrder: Record<Agent, readonly string[]>;
  /** Codex 같은 세대 안의 계열 순서(아래부터). 설정에 없는 Codex 새 모델의 자리를 정할 때 쓴다. */
  codexFamilyOrder: readonly string[];
  /** Runner가 보고할 Claude 모델(Q-06 승인표). Claude CLI는 모델 목록을 알려 주지 않으므로 설정값을 쓴다. */
  claudeModels: readonly string[];
}

const CODEX_FAMILIES = ['luna', 'terra', 'astra', 'sol'] as const;
/** Q-06 승인표의 Codex 모델(숨김 모델 제외) */
const Q06_CODEX = [
  'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-astra',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.5',
] as const;
/** Q-06 승인표의 Claude 모델, 아래 등급부터 */
const Q06_CLAUDE = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'] as const;

interface CodexKey {
  generation: number[];
  /** 모르는 계열이거나 계열이 없으면 -1(그 세대의 맨 아래) */
  family: number;
}

/** `gpt-<세대>[-<계열>]`을 읽는다. 읽을 수 없으면 null. */
function codexKey(id: string, familyOrder: readonly string[]): CodexKey | null {
  const m = /^gpt-(\d+(?:\.\d+)*)(?:-([a-z]+))?$/.exec(id);
  if (!m?.[1]) return null;
  return { generation: m[1].split('.').map(Number), family: m[2] ? familyOrder.indexOf(m[2]) : -1 };
}

function compareKeys(a: CodexKey, b: CodexKey): number {
  for (let i = 0; i < Math.max(a.generation.length, b.generation.length); i += 1) {
    const d = (a.generation[i] ?? 0) - (b.generation[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.family - b.family;
}

/**
 * Codex 모델을 아래 등급이 앞에 오도록 비교한다. 세대는 숫자로 비교하고(5.6 < 6 < 6.1 < 6.2 < 6.10),
 * 같은 세대 안에서는 계열 순서를 따른다. 계열이 없거나 모르는 계열은 그 세대의 맨 아래, 읽을 수 없는 이름은 전체 맨 아래다.
 */
export function compareCodexModels(a: string, b: string, familyOrder: readonly string[] = CODEX_FAMILIES): number {
  const ka = codexKey(a, familyOrder);
  const kb = codexKey(b, familyOrder);
  if (!ka || !kb) return (ka ? 1 : 0) - (kb ? 1 : 0);
  return compareKeys(ka, kb);
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  rankOrder: {
    Claude: Q06_CLAUDE,
    Codex: [...Q06_CODEX].sort((a, b) => compareCodexModels(a, b)),
  },
  codexFamilyOrder: CODEX_FAMILIES,
  claudeModels: Q06_CLAUDE,
};

/**
 * 설정 순서에 없는 모델(새로 보고된 모델)의 자리를 정해 새 순서를 돌려준다. 이미 있으면 그대로 돌려준다.
 * - Codex: 규칙(세대·계열)으로 자기보다 아래인 모델 중 가장 위에 있는 것 바로 위에 넣는다. 팀장이 바꾼 순서는 건드리지 않는다.
 * - 이름을 읽을 수 없는 Codex 모델과 Claude 새 모델: 맨 아래.
 * 새 모델은 「미허용」으로 등록되므로(G §7.2), 허용하기 전에 팀장이 자리를 확인한다.
 */
export function placeModel(order: readonly string[], id: string, agent: Agent, familyOrder: readonly string[]): string[] {
  if (order.includes(id)) return [...order];
  const key = agent === 'Codex' ? codexKey(id, familyOrder) : null;
  if (!key) return [id, ...order];
  let at = 0;
  order.forEach((other, index) => {
    const k = codexKey(other, familyOrder);
    if (k && compareKeys(k, key) < 0) at = index + 1;
  });
  return [...order.slice(0, at), id, ...order.slice(at)];
}

/** 순서(아래부터)를 rank로 바꾼다. 아래부터 1, 2, … */
export function modelRanks(order: readonly string[]): Map<string, number> {
  return new Map(order.map((id, index) => [id, index + 1]));
}
