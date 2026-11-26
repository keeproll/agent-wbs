import type { Agent } from '../api/generated/client.ts';
import type { ApiRequest } from '../api/client.ts';
import type { RunCommand } from '../readiness/command.ts';

/** POST /runner/models 본문 */
export type ModelsReport = ApiRequest<'reportModels'>['body'];
export type ModelEntry = ModelsReport['models'][number];

/**
 * 모델 ID와 Effort 값은 CLI가 알려 준 그대로 보낸다. 코드에 모델 ID를 적지 않는다(G §9.3-1).
 * 공통 단계(1~5) 매핑·ultra 제외·미확인 처리는 서버의 owner 승인표(Q-06)가 한다(contracts §3.1).
 *
 * **계약 보완(2026-11-26 owner 아이템 8)**: models 보고에는 `rank`를 싣지 않는다(보내면 400).
 * 모델 순서는 서버가 가진 설정값(`rankOrder`)이고, 서버가 rank를 계산한다. Runner는 무엇이 있는지만 알린다.
 * 그래서 Runner는 순서를 정하지 않고, CLI 목록 순서도 의미로 쓰지 않는다.
 */

/** 정책을 받기 전에만 쓰는 대체값. 정책을 받으면 `GET /runner/policy`의 `claudeModels`를 쓴다(contracts §3.1). */
export const DEFAULT_MODEL_SETTINGS = {
  /** Q-06 승인표의 Claude 모델. 서버 `claudeModels`를 받기 전의 대체값이다. */
  claudeModelIds: ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
} as const;

interface CodexModel {
  slug: string;
  display_name?: string;
  visibility?: string;
  supported_reasoning_levels?: { effort?: unknown }[];
}

const uniqueStrings = (values: unknown[]): string[] => [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== ''))];

/** `codex debug models --bundled` JSON. 목록에 보이는(`visibility: list`) 모델만 보낸다. */
export function parseCodexCatalog(text: string): ModelEntry[] {
  const data = JSON.parse(text) as { models?: unknown };
  if (!Array.isArray(data.models)) throw new Error('Codex 모델 목록 형식이 아닙니다(models 없음).');
  const models = data.models as CodexModel[];
  for (const m of models) {
    if (typeof m.slug !== 'string' || m.slug === '') throw new Error('Codex 모델 목록 형식이 아닙니다(slug 없음).');
  }
  const listed = models.filter((m) => m.visibility === 'list');
  return listed.map((m) => {
    const efforts = uniqueStrings((m.supported_reasoning_levels ?? []).map((l) => l.effort));
    return { id: m.slug, label: m.display_name || m.slug, efforts: efforts.length ? efforts : null };
  });
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
 * Claude CLI는 모델 목록을 알려 주지 않는다. 그래서 서버 정책의 `claudeModels`(설정값)를 보고 대상으로 쓰고,
 * 도움말의 Effort 값과 함께 보낸다. CLI에서 모델별 지원은 확인할 수 없다(Q-06 「CLI에서 모델별 동작은 미확인」).
 */
export function claudeModels(ids: readonly string[], efforts: string[] | null): ModelEntry[] {
  return uniqueStrings(ids.map((id) => id.trim())).map((id) => ({ id, label: id, efforts }));
}

export interface ModelProbe {
  run: RunCommand;
  codex: string;
  claude: string;
  /** 서버 정책의 `claudeModels`. 정책을 받기 전이면 없음 → `DEFAULT_MODEL_SETTINGS.claudeModelIds`. 빈 배열이면 보고하지 않는다. */
  claudeModelIds?: readonly string[];
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
    const models = parseCodexCatalog(r.stdout);
    return models.length ? { agent, models } : null;
  }
  const ids = p.claudeModelIds ?? DEFAULT_MODEL_SETTINGS.claudeModelIds;
  if (ids.every((id) => id.trim() === '')) return null;
  if (p.claudeEfforts === 'unknown') return { agent, models: claudeModels(ids, null) };
  const r = await p.run(p.claude, ['--help']);
  if (r.code !== 0) return null;
  return { agent, models: claudeModels(ids, parseClaudeEfforts(r.stdout)) };
}
