import type { Agent } from '../vocabulary.ts';

export type { Agent };
/** 공통 단계: 1 낮음 · 2 보통 · 3 높음 · 4 매우 높음 · 5 최대 (G §7.2) */
export type EffortLevel = 1 | 2 | 3 | 4 | 5;

type LevelMap = Readonly<Record<string, EffortLevel>>;

const TO_XHIGH: LevelMap = { low: 1, medium: 2, high: 3, xhigh: 4 };
const TO_MAX: LevelMap = { ...TO_XHIGH, max: 5 };

const all = (models: string[], map: LevelMap): [string, LevelMap][] => models.map((m) => [m, map]);

/**
 * owner가 승인한 Q-06 매핑(docs/plan/open-questions.md §0.2).
 * 표에 없는 모델·값(`ultra`, 숨김 모델, 새 모델)은 미확인이며 매핑하지 않는다. 바꾸려면 owner 승인이 필요하다.
 */
export const EFFORT_MAP: Readonly<Record<Agent, ReadonlyMap<string, LevelMap>>> = {
  Codex: new Map([
    ...all(
      [
        'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6.1-terra',
        'gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra',
        'gpt-6-luna', 'gpt-5.6-luna',
      ],
      TO_MAX,
    ),
    ...all(['gpt-5.5'], TO_XHIGH),
  ]),
  Claude: new Map(
    all(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], TO_MAX),
  ),
};

/** CLI 값 → 공통 단계. 승인된 매핑이 없으면 null. */
export function effortLevel(agent: Agent, modelId: string, effort: string): EffortLevel | null {
  const map = EFFORT_MAP[agent].get(modelId);
  return map && Object.hasOwn(map, effort) ? (map[effort] ?? null) : null;
}

/** 공통 단계 → CLI 값. 그 모델에 없는 단계나 미확인 모델이면 null. */
export function effortValue(agent: Agent, modelId: string, level: EffortLevel): string | null {
  const map = EFFORT_MAP[agent].get(modelId);
  return Object.entries(map ?? {}).find(([, l]) => l === level)?.[0] ?? null;
}
