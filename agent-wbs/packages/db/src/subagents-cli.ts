/**
 * `pnpm subagents:check` — 실제 하위 Agent v1 정의를 검사한다(M5-06 완료 조건).
 * 문제가 하나라도 있으면 목록을 출력하고 종료 코드 1로 끝난다. DB에는 접속하지 않는다.
 */
import { checkSubagentSet, loadMockSubagents, loadSubagentSet } from './subagents.ts';

const set = await loadSubagentSet();
const issues = checkSubagentSet(set, await loadMockSubagents());
for (const d of set.defs) console.log(`${d.agent.padEnd(6)} ${d.key}@${String(d.version)} ${d.hash.slice(0, 12)} ${d.sandbox}`);
if (issues.length) {
  for (const i of issues) console.error(`✗ ${i.key} [${i.rule}] ${i.message}`);
  console.error(`하위 Agent 정의 문제 ${String(issues.length)}건`);
  process.exitCode = 1;
} else {
  console.log(`하위 Agent 정의 ${String(set.defs.length)}개 — hash·버전·model/effort 부재·허용 도구·SUB_MOCK 문안·충돌 지시 문제 0건`);
}
