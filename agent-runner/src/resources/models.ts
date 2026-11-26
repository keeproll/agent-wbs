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
 */

interface CodexModel {
  slug: string;
  display_name?: string;
  visibility?: string;
  priority?: number;
  supported_reasoning_levels?: { effort?: unknown }[];
}

const uniqueStrings = (values: unknown[]): string[] => [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== ''))];

/** `codex debug models --bundled` JSON. 목록에 보이는(`visibility: list`) 모델만, priority가 작을수록 위 등급. */
export function parseCodexCatalog(text: string): ModelEntry[] {
  const data = JSON.parse(text) as { models?: unknown };
  if (!Array.isArray(data.models)) throw new Error('Codex 모델 목록 형식이 아닙니다(models 없음).');
  const models = data.models as CodexModel[];
  for (const m of models) {
    if (typeof m.slug !== 'string' || m.slug === '') throw new Error('Codex 모델 목록 형식이 아닙니다(slug 없음).');
  }
  const listed = models
    .filter((m) => m.visibility === 'list')
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
  return listed.map((m, i) => {
    const efforts = uniqueStrings((m.supported_reasoning_levels ?? []).map((l) => l.effort));
    return { id: m.slug, label: m.display_name || m.slug, rank: listed.length - i, efforts: efforts.length ? efforts : null };
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
 * Claude Code CLI에는 무료 모델 목록 명령이 없다. 그래서 운영자가 설정한 모델 ID(앞일수록 위 등급)를
 * 도움말의 Effort 값과 함께 보낸다. CLI에서 모델별 지원은 확인할 수 없다(Q-06 「CLI에서 모델별 동작은 미확인」).
 */
export function claudeModels(ids: readonly string[], efforts: string[] | null): ModelEntry[] {
  const list = uniqueStrings(ids.map((id) => id.trim()));
  return list.map((id, i) => ({ id, label: id, rank: list.length - i, efforts }));
}

export interface ModelProbe {
  run: RunCommand;
  codex: string;
  claude: string;
  claudeModelIds: readonly string[];
}

/** 보고할 본문. 확인하지 못했으면 null — 빈 목록을 보내 이미 등록된 모델을 흔들지 않는다. */
export async function collectModels(agent: Agent, p: ModelProbe): Promise<ModelsReport | null> {
  if (agent === 'Codex') {
    const r = await p.run(p.codex, ['debug', 'models', '--bundled']);
    if (r.code !== 0) return null;
    const models = parseCodexCatalog(r.stdout);
    return models.length ? { agent, models } : null;
  }
  if (p.claudeModelIds.every((id) => id.trim() === '')) return null;
  const r = await p.run(p.claude, ['--help']);
  if (r.code !== 0) return null;
  return { agent, models: claudeModels(p.claudeModelIds, parseClaudeEfforts(r.stdout)) };
}
