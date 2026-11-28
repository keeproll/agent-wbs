import { Ajv2020 } from 'ajv/dist/2020.js';
import { PLANNING_REPORT_SCHEMAS } from '../api/generated/client.ts';
import type { Agent } from '../api/generated/client.ts';
import { createParser } from '../cli/adapters.ts';
import { JsonlDecoder } from '../cli/stream.ts';
import type { CommandResult } from '../readiness/command.ts';
import type { PlanningAgent, PlanningAgents } from './agents.ts';

interface Schema { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; anyOf?: Schema[]; [key: string]: unknown }
const reports = PLANNING_REPORT_SCHEMAS as unknown as Record<string, Schema>;
const pick = (source: Schema, keys: string[]): Schema => source.anyOf ? { anyOf: source.anyOf.map(branch => pick(branch, keys)) }
  : { ...source, properties: Object.fromEntries(Object.entries(source.properties ?? {}).filter(([key]) => keys.includes(key))), required: source.required?.filter(key => keys.includes(key)) ?? [] };
function withoutJudgements(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutJudgements);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'judgedRules').map(([key, item]) => [key, key === 'required' && Array.isArray(item) ? item.filter(v => v !== 'judgedRules') : withoutJudgements(item)]));
}
const text = { type: 'string', minLength: 1 };
const list = (items: Schema): Schema => ({ type: 'array', items });
const object = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const enumOf = (...values: string[]): Schema => ({ type: 'string', enum: values });
const verdict = { rule: text, result: enumOf('met', 'not_met'), basis: text };
const draft = withoutJudgements(pick(reports.submitDraft as Schema, ['phases', 'wps', 'tasks', 'deps'])) as Schema;
const draftTask = draft.properties?.tasks?.items;
if (!draftTask?.properties) throw new Error('Planning 초안 계약이 없습니다.');
delete draftTask.properties.estimate;
draftTask.required = draftTask.required?.filter(key => key !== 'estimate') ?? [];
const estimate = reports.submitEstimates?.properties?.items?.items;
if (!estimate) throw new Error('Planning 추정 계약이 없습니다.');
const estimateItem = pick(estimate, ['estHours', 'loHours', 'hiHours', 'tokensK', 'confidence', 'basis']);
estimateItem.properties = { ...estimateItem.properties, ref: text };
estimateItem.required = [...new Set([...(estimateItem.required ?? []), 'ref', 'basis'])];
export const PLANNING_OUTPUTS: Record<Exclude<keyof PlanningAgent, 'name'>, Schema> = {
  analyze: pick(reports.submitPlanningAnalysis as Schema, ['summary', 'items']),
  crossReview: object({ summary: text, reviews: reports.submitPlanningReviews?.properties?.reviews as Schema,
    tech: pick(reports.submitTechProposals as Schema, ['decisions', 'conditionJudgements']) }),
  draft,
  proposeChanges: withoutJudgements(pick(reports.submitPlanningProposal as Schema, ['title', 'reason', 'ops'])) as Schema,
  proposeSplit: withoutJudgements(pick(reports.submitPlanningProposal as Schema, ['title', 'reason', 'ops'])) as Schema,
  planTask: pick(reports.submitTaskPlan as Schema, ['grades', 'subagents', 'conflictGroup']),
  estimate: list(estimateItem),
  judgeRules: list(object({ target: text, ...verdict })),
  judgeSplit: list(object(verdict)),
};

/** 기존 JSONL 해석기를 통과한 최종 메시지만 받는다. 종료 성공·JSON·출력 계약 중 하나라도 없으면 실패다. */
export function planningText(agent: Agent, result: CommandResult): string {
  const decoder = new JsonlDecoder(), parse = createParser(agent);
  let ok = false, message: string | undefined;
  for (const record of [...decoder.push(Buffer.from(result.stdout)), ...decoder.end()]) for (const event of parse(record)) {
    if (event.type === 'result') { ok = event.ok; if (event.text !== undefined) message = event.text; }
    if (event.type === 'message') message = event.text;
    if (event.type === 'agent_call' || event.type === 'subagent_unlinked') throw new Error('Planning에서 하위 Agent 호출을 허용하지 않습니다.');
  }
  if (result.code !== 0 || !ok || message === undefined) throw new Error('Planning CLI의 정상 종료와 최종 답을 확인하지 못했습니다.');
  return message;
}

export function planningAgents(run: (agent: Agent, prompt: string) => Promise<CommandResult>): PlanningAgents {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const components = withoutJudgements(reports.components);
  const validators = Object.fromEntries(Object.entries(PLANNING_OUTPUTS).map(([method, schema]) => [method, ajv.compile({ ...schema, components })]));
  const make = (name: Agent): PlanningAgent => {
    const agent: Record<string, unknown> = { name };
    for (const [method, schema] of Object.entries(PLANNING_OUTPUTS)) agent[method] = async (request: unknown) => {
      const prompt = `Planning 질문: ${method}\n입력 자료만 읽고 분석하세요. 파일 수정·명령 설치·외부 쓰기·하위 Agent 호출은 금지합니다. 판단 근거를 지어내지 마세요. decisionGuide가 있으면 그대로 따르세요.\n마지막 메시지는 아래 JSON Schema를 만족하는 JSON 하나만 내세요. agreedBy·judgedRules는 Runner가 계산합니다.\n출력 계약: ${JSON.stringify({ ...schema, components })}\n요청: ${JSON.stringify(request)}`;
      const value: unknown = JSON.parse(planningText(name, await run(name, prompt)));
      if (!validators[method]?.(value)) throw new Error(`Planning ${method} 출력이 계약과 다릅니다: ${ajv.errorsText(validators[method]?.errors)}`);
      return value;
    };
    return agent as unknown as PlanningAgent;
  };
  return { Codex: make('Codex'), Claude: make('Claude') };
}
