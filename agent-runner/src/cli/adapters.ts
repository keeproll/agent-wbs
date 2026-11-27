import type { Agent } from '../api/generated/client.ts';
import { createClaudeParser } from './claude.ts';
import { createCodexParser } from './codex.ts';
import type { CliEvent, Json } from './events.ts';
import type { StreamRecord } from './stream.ts';

/** 한 세션 스트림의 해석기. 줄을 받을 때마다 이벤트를 돌려준다. JSON이 아닌 줄도 `unparsed`로 그대로 넘긴다. */
export function createParser(agent: Agent): (record: StreamRecord) => CliEvent[] {
  const parse: (e: Json) => CliEvent[] = agent === 'Claude' ? createClaudeParser() : createCodexParser();
  return (record) => {
    if (record.kind === 'json') return parse(record.value);
    const { line, raw, reason, bytes } = record;
    return [{ type: 'unparsed', line, raw, reason, bytes }];
  };
}

export function parseStream(agent: Agent, records: readonly StreamRecord[]): CliEvent[] {
  const parse = createParser(agent);
  return records.flatMap(parse);
}
