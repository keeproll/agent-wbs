import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 가짜 Agent CLI(`agent-cli.mjs`) 시나리오. */
export interface AgentScenario { agent: 'claude' | 'codex'; devInvalidFirst?: boolean; fixInvalid?: boolean; qaDirty?: boolean; qaVerdict?: 'PASS' | 'FAIL'; calls?: string }
export const AGENT_CLI_SCRIPT = join(import.meta.dirname, 'agent-cli.mjs');

/**
 * 같은 계정 시험용: dir에 실행 파일 `<agent>`를 만든다. 호출 기록은 `<agent>.calls.jsonl`.
 * 시나리오는 파일로 둬서 실행 중에도 바꿀 수 있다(`setScenario`).
 */
export function installAgentCli(dir: string, scenario: AgentScenario) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, scenario.agent);
  const scenarioPath = join(dir, `${scenario.agent}.agent.json`);
  const calls = join(dir, `${scenario.agent}.calls.jsonl`);
  const set = (next: AgentScenario) => writeFileSync(scenarioPath, JSON.stringify({ ...next, calls }));
  set(scenario);
  writeFileSync(calls, '');
  const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;
  writeFileSync(path, `#!/bin/sh\nexec ${[process.execPath, AGENT_CLI_SCRIPT, scenarioPath].map(quote).join(' ')} "$@"\n`);
  chmodSync(path, 0o755);
  return {
    path, scenarioPath, setScenario: set,
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { argv: string[]; cwd: string; stdin: string }),
  };
}
