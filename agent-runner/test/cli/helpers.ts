import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '../../src/api/generated/client.ts';
import { parseStream } from '../../src/cli/adapters.ts';
import { JsonlDecoder } from '../../src/cli/stream.ts';

export const fixturePath = (agent: Agent, name: string) => join(import.meta.dirname, 'fixtures', agent.toLowerCase(), `${name}.jsonl`);
export const fixture = (agent: Agent, name: string) => readFileSync(fixturePath(agent, name));

/** fixture 바이트를 실제 파이프처럼 작은 조각으로 나눠 해석한다. */
export function parseFixture(agent: Agent, name: string, chunk = 7) {
  const bytes = fixture(agent, name);
  const d = new JsonlDecoder();
  const records = [];
  for (let i = 0; i < bytes.length; i += chunk) records.push(...d.push(bytes.subarray(i, i + chunk)));
  records.push(...d.end());
  return { records, events: parseStream(agent, records) };
}
