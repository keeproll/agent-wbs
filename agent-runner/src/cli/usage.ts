import type { CliEvent } from './events.ts';

/** 설치한 지정 정의(getTaskSubagents items 중 Runner가 쓰는 칸) */
export interface InstalledDefinition { id: string; key: string; version: number; hash: string }
/** 서버 `subagent-usage` 보고의 한 항목(contracts §3.2) */
export interface UsageItem { id: string; version: number | null; hash: string | null; count: number }

/** 서버 계약 `SubagentName`의 길이(1~128자). 넘는 이름은 보고하지 않는다(지어 줄이지 않음). */
const MAX_NAME = 128;
/** 서버가 받는 이름: 공백 아닌 글자 1개 이상, NUL 없음(계약 SubagentName과 같은 규칙). 아니면 「모름」으로 버린다. */
const validName = (name: string) => /\S/.test(name) && !name.includes('\u0000');

/**
 * 실제로 부른 하위 Agent 이름과 횟수를 출력 스트림에서 모은다(UAT-TASK-10 「실제」 태그의 재료, G §6.7-7).
 * - Claude: `Agent`(옛 `Task`) 도구 호출 입력의 `subagent_type`. 같은 호출 id는 한 번만 센다.
 * - Codex: `exec --json` 협업 이벤트에 하위 Agent 이름이 없다. 그래서 이름을 모으지 않는다(빈 목록 = 모름).
 * - 이름을 모르는 호출은 세지 않는다. 이 값은 출력 관측이므로 보고 확정도는 항상 `partial`(일부 관측)이다.
 */
export class SubagentUsage {
  readonly #calls = new Set<string>();
  readonly #counts = new Map<string, number>();

  apply(e: CliEvent): void {
    if (e.type !== 'agent_call' || !e.agentType || this.#calls.has(e.id)) return;
    this.#calls.add(e.id);
    this.#counts.set(e.agentType, (this.#counts.get(e.agentType) ?? 0) + 1);
  }

  /** 보고 항목. 설치한 지정 정의 이름이면 그 정의의 id·버전·hash를 붙이고, 아니면 이름만 보낸다. */
  items(installed: readonly InstalledDefinition[]): UsageItem[] {
    return [...this.#counts].filter(([name]) => name.length <= MAX_NAME && validName(name)).map(([name, count]) => {
      const def = installed.find(d => d.key === name);
      return def ? { id: def.id, version: def.version, hash: def.hash, count } : { id: name, version: null, hash: null, count };
    });
  }
}
