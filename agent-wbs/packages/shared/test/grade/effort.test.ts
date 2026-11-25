import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { EFFORT_MAP, effortLevel, effortValue } from '../../src/grade/index.ts';
import type { AgentName, EffortLevel } from '../../src/grade/index.ts';

const DOC = readFileSync(
  new URL('../../../../../docs/plan/open-questions.md', import.meta.url),
  'utf8',
);
const section = DOC.slice(DOC.indexOf('### 0.2 Q-06'), DOC.indexOf('\n## 1.'));
const rows = section
  .split('\n')
  .filter((l) => /^\| (Codex|Claude) \|/.test(l))
  .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));

/** 표의 축약 모델명을 ID로 푼다: `gpt-6.2-sol · 6.2-astra`, `claude-fable-5-2 · opus-5-5`. */
const modelIds = (cell: string): string[] => {
  const names = cell.split(' · ');
  const prefix = /^(gpt|claude)-/.exec(names[0] ?? '')?.[0] ?? '';
  return names.map((n) => (n.startsWith(prefix) ? n : prefix + n));
};
const approved = rows.filter((r) => r[2] === 'low');

test('owner 승인 Q-06 표의 모든 모델·단계와 일치하고 그 밖의 모델은 없다', () => {
  expect(rows).toHaveLength(6);
  expect(approved).toHaveLength(4);
  const seen: Record<AgentName, string[]> = { Claude: [], Codex: [] };
  for (const r of approved) {
    const agent = r[0] as AgentName;
    for (const id of modelIds(r[1] ?? '')) {
      seen[agent].push(id);
      r.slice(2, 7).forEach((cell, i) => {
        const level = (i + 1) as EffortLevel;
        const want = cell === '없음' ? null : cell;
        expect(effortValue(agent, id, level), `${id} ${String(level)}`).toBe(want);
        if (want) expect(effortLevel(agent, id, want)).toBe(level);
      });
    }
  }
  expect([...EFFORT_MAP.Codex.keys()].sort()).toEqual(seen.Codex.sort());
  expect([...EFFORT_MAP.Claude.keys()].sort()).toEqual(seen.Claude.sort());
  expect(seen.Codex).toHaveLength(11);
  expect(seen.Claude).toHaveLength(4);
});

test('ultra는 어떤 모델에서도 매핑되지 않는다', () => {
  for (const agent of ['Codex', 'Claude'] as const) {
    for (const id of EFFORT_MAP[agent].keys()) expect(effortLevel(agent, id, 'ultra')).toBeNull();
  }
});

test('미확인 모델·다른 CLI의 모델·상속 속성 이름은 거부한다', () => {
  expect(effortLevel('Codex', 'codex-large', 'high')).toBeNull();
  expect(effortLevel('Claude', 'claude-fable-5-1', 'high')).toBeNull();
  expect(effortLevel('Claude', 'gpt-6.1-sol', 'high')).toBeNull();
  expect(effortLevel('Codex', 'gpt-6.1-sol', 'constructor')).toBeNull();
  expect(effortLevel('Codex', 'gpt-5.5', 'max')).toBeNull();
  expect(effortValue('Codex', 'gpt-7', 3)).toBeNull();
});
