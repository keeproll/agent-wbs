import { expect, test, vi } from 'vitest';
import { parseContracts } from '../../src/design/parse.ts';
import { compareShapes, schemaFields } from '../../src/design/shape.ts';
import { buildDesignSnapshot } from '../../src/design/snapshot.ts';

const api = (schema: object) => JSON.stringify({ openapi: '3.1.0', paths: { '/users': { post: { requestBody: { content: { 'application/json': { schema } } }, responses: {} } } } });
const source = (raw: string, path = 'contracts/api/openapi.json') => ({ path, raw });
const input = (files: ReturnType<typeof source>[]) => ({ commit: 'a'.repeat(40), jobId: 'job', fence: 1, ref: 'main', jobKind: 'design_apply' as const, files });

test('H1 원문·미확인 protocol·TRACE는 서버가 거부할 항목을 만들지 않는다', async () => {
  const snapshot = await buildDesignSnapshot(input([
    source('원문', 'contracts/db/neo4j/model.cypher'), source('원문', 'contracts/notes.'),
    source(JSON.stringify({ asyncapi: '3.0.0', channels: { e: { address: 'events', messages: {} } } }), 'contracts/events/asyncapi.json'),
    source(JSON.stringify({ openapi: '3.1.0', paths: { '/trace': { trace: { responses: {} } }, '/ok': { get: { responses: {} } } } })),
  ]));
  expect(snapshot.items.map(i => i.itemKey)).toEqual(['GET /ok']);
  expect(snapshot.files.every(f => f.format.trim())).toBe(true);
  expect(snapshot.files[0]?.raw).toBe('원문');
});

test('H1 특수 속성과 배열·추가 속성 주소가 충돌하면 해당 항목만 unchecked다', () => {
  const r = parseContracts([source(api({ type: ['object', 'array'], properties: { '*': { type: 'string' } }, items: { type: 'number' } }))]);
  expect(r.items[0]?.contract).toBeUndefined();
});

test('H2 18KB 참조 DAG 120개가 필드를 지수적으로 펼치지 않는다', () => {
  const schemas: Record<string, unknown> = {};
  for (let depth = 0; depth < 5; depth++) schemas[`S${depth}`] = { type: 'object', properties: Object.fromEntries(Array.from({ length: 10 }, (_, w) => [`p${w}`, depth === 4 ? { type: 'string' } : { $ref: `#/components/schemas/S${depth + 1}` }])) };
  const paths = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`/x${i}`, { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } } } } } }]));
  const raw = JSON.stringify({ openapi: '3.1.0', paths, components: { schemas } });
  const at = performance.now();
  const parsed = parseContracts([source(raw)]);
  expect(parsed.items).toHaveLength(120);
  expect(parsed.items.every(i => i.contract === undefined)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThan(1024 * 1024);
  expect(performance.now() - at).toBeLessThan(2000);
});

test('H3 알 수 없는 검증 키워드를 any로 바꾸지 않는다', () => {
  for (const schema of [{ type: 'string', nullable: true }, { dependencies: { a: ['b'] } }, { madeUp: true }, { schemaFormat: 'avro', schema: {} }, { type: 'any' }, { $id: 'https://schema.invalid/local', type: 'object' }, { type: 'string', readOnly: true }]) {
    expect(() => schemaFields(schema, schema, '/body', false)).toThrow();
  }
});

test('Q-a enum·const·format 변화는 타입 지문에 반영하고 enum 순서는 무시한다', () => {
  for (const [before, after] of [
    [{ type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['a'] }],
    [{ type: 'string', format: 'uuid' }, { type: 'string', format: 'date-time' }],
    [{ type: 'integer', const: 1 }, { type: 'integer', const: 2 }],
  ]) expect(compareShapes({ fields: schemaFields(before, before, '/body', false) }, { fields: schemaFields(after, after, '/body', false) })?.compat).toBe('breaking');
  expect(schemaFields({ type: 'string', enum: ['b', 'a'] }, {}, '/body', false)).toEqual(schemaFields({ type: 'string', enum: ['a', 'b'] }, {}, '/body', false));
});

test('H3 참조된 Multi Format JSON Schema는 풀고 Avro는 unchecked다', () => {
  const doc = (format: string) => JSON.stringify({ asyncapi: '3.0.0', servers: { k: { protocol: 'kafka' } }, channels: { c: { address: 'event', messages: { m: { payload: { $ref: '#/components/schemas/M' } } } } },
    components: { schemas: { M: { schemaFormat: format, schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } } } });
  expect(parseContracts([source(doc('application/schema+json'), 'contracts/events/asyncapi.json')]).items[0]?.contract?.fields).toContainEqual({ path: '/messages/m/payload/id', type: 'string', required: true });
  expect(parseContracts([source(doc('application/vnd.apache.avro'), 'contracts/events/asyncapi.json')]).items[0]?.contract).toBeUndefined();
});

test('Q-c 요청·응답·메시지의 호환 방향을 나눈다', () => {
  const f = (path: string, required: boolean) => ({ fields: [{ path, type: 'string', required }] });
  expect(compareShapes(f('/requestBody/id', false), { fields: [] }, 'REST')?.compat).toBe('compatible');
  expect(compareShapes(f('/responses/200/id', true), f('/responses/200/id', false), 'REST')?.compat).toBe('breaking');
  expect(compareShapes({ fields: [] }, f('/responses/200/new', true), 'REST')?.compat).toBe('compatible');
  expect(compareShapes(f('/messages/m/id', true), f('/messages/m/id', false), 'Kafka')?.compat).toBe('breaking');
});

test('M2 멈춘 추출기를 시간 제한 뒤 unchecked로 바꾸고 signal로 취소를 알린다', async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const pending = buildDesignSnapshot(input([source(api({ type: 'string' }))]), { openapi: ctx => { signal = ctx.signal; return new Promise(() => { /* 추출 결과가 오지 않는다. */ }); } });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result.drifts[0]?.compat).toBe('unchecked');
  } finally { vi.useRealTimers(); }
});

test('M3 같은 토픽의 중복은 그 항목만 unchecked이고 정상 REST는 보존한다', async () => {
  const event = JSON.stringify({ asyncapi: '3.0.0', servers: { k: { protocol: 'kafka' } }, channels: { c: { address: 'event', messages: {} } } });
  const result = await buildDesignSnapshot(input([source(event, 'contracts/events/a.json'), source(event, 'contracts/events/b.json'), source(api({ type: 'string' }))]), { openapi: async ({ item }) => item.contract, asyncapi: async ({ item }) => item.contract });
  expect(result.items.map(i => i.itemKey).sort()).toEqual(['POST /users', 'event']);
  expect(result.drifts.find(d => d.itemKey === 'event')).toMatchObject({ compat: 'unchecked', text: expect.stringContaining('중복') });
  expect(result.drifts).toHaveLength(1);
});

test('ref는 생략하지 않고 main 권한과 attempt 자신의 브랜치를 검사한다', async () => {
  const base = input([source(api({ type: 'string' }))]);
  await expect(buildDesignSnapshot({ ...base, jobKind: 'attempt', branch: 'agent/TASK-0001' })).rejects.toThrow();
  await expect(buildDesignSnapshot({ ...base, jobKind: 'attempt', branch: 'agent/TASK-0001', ref: 'agent/TASK-0002' })).rejects.toThrow();
  await expect(buildDesignSnapshot({ ...base, jobKind: 'attempt', branch: 'agent/TASK-0001-h3', ref: 'agent/TASK-0001-h3' })).resolves.toMatchObject({ ref: 'agent/TASK-0001-h3' });
  for (const ref of ['', 'Main', 'refs/heads/main', 'agent/task-0001']) await expect(buildDesignSnapshot({ ...base, ref })).rejects.toThrow();
});

test('추출 전체 기한을 넘으면 뒤 항목은 시작하지 않고 모두 unchecked로 보고한다', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const raw = JSON.stringify({ openapi: '3.1.0', paths: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`/u${i}`, { get: { responses: {} } }])) });
    let started = 0;
    const pending = buildDesignSnapshot(input([source(raw)]), { openapi: () => { started++; return new Promise(() => { /* 멈춘 추출기 */ }); } });
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await pending;
    expect(started).toBe(10);
    expect(result.drifts).toHaveLength(30);
    expect(result.drifts.every(d => d.compat === 'unchecked')).toBe(true);
  } finally { vi.useRealTimers(); }
});

test('크기 상한으로 SQL 파일을 생략하면 이전 일부 스키마를 성공으로 보내지 않는다', () => {
  const result = parseContracts([source('CREATE TABLE t(id integer);', 'contracts/db/postgres/001.sql'), source(' '.repeat(1024 * 1024 + 1), 'contracts/db/postgres/002.sql')]);
  expect(result.items).toEqual([]);
  expect(result.files.every(f => f.status === 'error')).toBe(true);
});
