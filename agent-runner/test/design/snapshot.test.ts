import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createApiClient } from '../../src/api/client.ts';
import { Outbox } from '../../src/api/outbox.ts';
import { Secret } from '../../src/security/secret.ts';
import { State } from '../../src/state/state.ts';
import { parseContracts } from '../../src/design/parse.ts';
import { buildDesignSnapshot, reportDesignSnapshot, type DesignExtractor } from '../../src/design/snapshot.ts';

const commit = 'a'.repeat(40);
const raw = (properties: object, required: string[] = []) => JSON.stringify({ openapi: '3.1.0', paths: {
  '/users': { post: { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties, required } } } }, responses: {} } },
} });
const input = { commit, jobId: 'job-1', fence: 4, ref: 'main', jobKind: 'design_apply' as const, files: [{ path: 'contracts/api/openapi.json', raw: raw({ id: { type: 'string' }, name: { type: 'string' } }) }] };
const generated: DesignExtractor = async ({ item }) => {
  const [actual] = parseContracts([{ path: 'contracts/api/generated.json', raw: raw({ id: { type: 'number' } }) }]).items;
  return actual?.itemKey === item.itemKey ? actual.contract : null;
};

test('실제 명세를 해석한 필드 목록과 breaking 참고값을 서버에 모두 넘긴다', async () => {
  const snapshot = await buildDesignSnapshot(input, { openapi: generated });
  expect(snapshot).toMatchObject({ jobId: 'job-1', fence: 4, commit, ref: 'main' });
  expect(snapshot.items[0]?.contract?.fields).toContainEqual({ path: '/requestBody/content/application~1json/name', type: 'string', required: false });
  expect(snapshot.items[0]?.extracted?.fields).toContainEqual({ path: '/requestBody/content/application~1json/id', type: 'number', required: false });
  expect(snapshot.drifts).toEqual([{ itemKey: 'POST /users', kind: 'REST', compat: 'breaking', where: '/requestBody/content/application~1json/id, /requestBody/content/application~1json/name', text: expect.any(String) }]);
});

test('어댑터 없음·추출 실패·null·깨진 필드 목록은 extracted null과 대조 안 함을 남긴다', async () => {
  const failures: (DesignExtractor | undefined)[] = [undefined, async () => { throw new Error('연결 실패'); }, async () => null,
    async () => ({ fields: [{ path: '/id', type: 123, required: false }] }),
    async () => ({ fields: [{ path: '/id', type: 'string', required: false }, { path: '/id', type: 'number', required: false }] }),
  ];
  for (const openapi of failures) {
    const snapshot = await buildDesignSnapshot(input, openapi ? { openapi } : {});
    expect(snapshot.items[0]?.extracted).toBeNull();
    expect(snapshot.drifts).toEqual([{ itemKey: 'POST /users', kind: 'REST', where: '/', text: expect.stringContaining('대조 안 함'), compat: 'unchecked' }]);
  }
});

test('일치는 drift를 만들지 않고 선택 필드 추가는 compatible이다', async () => {
  const match: DesignExtractor = async ({ item }) => item.contract;
  expect((await buildDesignSnapshot(input, { openapi: match })).drifts).toEqual([]);
  const added: DesignExtractor = async ({ item }) => ({ fields: [...(item.contract?.fields ?? []), { path: '/extra', type: 'string', required: false }] });
  expect((await buildDesignSnapshot(input, { openapi: added })).drifts[0]?.compat).toBe('compatible');
});

test('branch·Task 연결을 유지하고 외부 어댑터가 계약 필드를 바꾸지 못하게 한다', async () => {
  let context: unknown;
  const source = input.files[0];
  if (!source) throw new Error('시험 입력이 없습니다.');
  const snapshot = await buildDesignSnapshot({ ...input, ref: 'agent/TASK-0005', jobKind: 'attempt', branch: 'agent/TASK-0005', files: [{ path: source.path,
    raw: source.raw.replace('"post":{', '"post":{"x-task-key":"TASK-0005",'),
  }] }, { openapi: async received => {
    context = { commit: received.commit, ref: received.ref, itemKey: received.item.itemKey };
    const field = received.item.contract?.fields[0];
    if (!field) throw new Error('시험 필드가 없습니다.');
    field.type = 'number';
    return received.item.contract;
  } });
  expect(context).toEqual({ commit, ref: 'agent/TASK-0005', itemKey: 'POST /users' });
  expect(snapshot.files[0]?.status).toBe('draft');
  expect(snapshot.items[0]?.contract?.fields[0]?.type).toBe('object');
  expect(snapshot.drifts[0]).toMatchObject({ taskKey: 'TASK-0005', compat: 'breaking' });
});

test('미지원 계약은 추출값이 있어도 unchecked이고 raw를 보존한다', async () => {
  const snapshot = await buildDesignSnapshot({ ...input, files: [{ path: 'contracts/db/neo4j/model.cypher', raw: 'CREATE CONSTRAINT foo' }] });
  expect(snapshot.files[0]?.raw).toBe('CREATE CONSTRAINT foo');
  expect(snapshot.items).toEqual([]);
  expect(snapshot.drifts).toEqual([]);
});

test('SQL·AsyncAPI 어댑터는 자기 항목만 추출하고 한 항목의 실패가 나머지를 막지 않는다', async () => {
  const seen: string[] = [];
  const snapshot = await buildDesignSnapshot({ ...input, files: [
    { path: 'contracts/db/postgres/migrations/001.sql', raw: 'CREATE TABLE users (id uuid PRIMARY KEY);' },
    { path: 'contracts/events/asyncapi.json', raw: JSON.stringify({ asyncapi: '3.0.0', servers: { ws: { protocol: 'ws' } }, channels: { updates: { address: 'updates', messages: { changed: { payload: { type: 'string' } } } } } }) },
  ] }, {
    sql: async ({ item }) => { seen.push(item.itemKey); return item.contract; },
    asyncapi: async ({ item }) => { seen.push(item.itemKey); throw new Error('추출 실패'); },
  });
  expect(seen.sort()).toEqual(['postgres:users', 'updates']);
  expect(snapshot.items.find(i => i.itemKey === 'postgres:users')?.extracted?.fields).toEqual([{ path: '/id', type: 'uuid', required: true }]);
  expect(snapshot.drifts.map(d => [d.itemKey, d.compat])).toEqual([['updates', 'unchecked']]);
});

test('commit·fence·jobId·ref를 검증해 고정되지 않은 결과를 보고하지 않는다', async () => {
  for (const bad of [{ commit: 'HEAD' }, { fence: -1 }, { fence: 1.5 }, { fence: 2147483648 }, { jobId: '' }, { ref: '' }]) {
    await expect(buildDesignSnapshot({ ...input, ...bad })).rejects.toThrow();
  }
});

test('design_apply의 job/fence와 main 결과를 먼저 저장하고 재시작 뒤 같은 멱등 키로 전송한다', async () => {
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'design-outbox-'));
  let state: State | undefined;
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  const api = createApiClient({ baseUrl: 'http://wbs.invalid', token: new Secret('fake-token'), fetch: async (url, options) => {
    requests.push({ url: String(url), headers: new Headers(options?.headers), body: JSON.parse(String(options?.body)) as unknown });
    return new Response(null, { status: 204 });
  } });
  try {
    state = await State.open(home);
    const entry = await reportDesignSnapshot(new Outbox(state, api), { epoch: 0, ...input });
    expect(requests).toEqual([]);
    expect(JSON.parse(await readFile(join(home, 'state/runner.json'), 'utf8'))).toMatchObject({ outbox: [{ operation: 'reportDesignSnapshot', request: { body: { jobId: 'job-1', fence: 4, commit, ref: 'main' } } }] });
    await state.close();
    state = await State.open(home);
    await new Outbox(state, api).flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://wbs.invalid/api/runner/design/snapshot');
    expect(requests[0]?.headers.get('idempotency-key')).toBe(entry.request.idempotencyKey);
    expect(requests[0]?.headers.get('x-project-epoch')).toBe('0');
    expect(requests[0]?.body).toMatchObject({ jobId: 'job-1', fence: 4, commit, ref: 'main', items: [{ extracted: null }], drifts: [{ compat: 'unchecked' }] });
    expect(state.snapshot.outbox).toEqual([]);
  } finally {
    await state?.close();
    await rm(home, { recursive: true, force: true });
  }
});
