import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createApiClient } from '../../src/api/client.ts';
import { Outbox } from '../../src/api/outbox.ts';
import { Secret } from '../../src/security/secret.ts';
import { State } from '../../src/state/state.ts';
import { parseContracts } from '../../src/design/parse.ts';
import { schemaFields } from '../../src/design/shape.ts';
import { buildDesignSnapshot, reportDesignSnapshot } from '../../src/design/snapshot.ts';

test.each([false, true])('P2-1 보류는 같은 ref만 막고 다른 ref·종류는 전송한다 (기존 stream=%s)', async legacy => {
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'design-ref-'));
  let state = await State.open(home);
  let now = 0, hold = true;
  const sent: { job: string; key: string | null }[] = [];
  const api = createApiClient({ baseUrl: 'http://wbs.invalid', token: new Secret('fake'), fetch: async (_url, options) => {
    const body = JSON.parse(String(options?.body)) as { jobId?: string };
    const job = body.jobId ?? 'usage';
    sent.push({ job, key: new Headers(options?.headers).get('idempotency-key') });
    return job === 'apply-1' && hold
      ? new Response(JSON.stringify({ error: { code: 'EXTERNAL_WRITE_BLOCKED', message: '권한 대조 중' } }), { status: 409, headers: { 'content-type': 'application/json' } })
      : new Response(null, { status: 204 });
  } });
  const box = () => new Outbox(state, api, { now: () => now, monotonic: () => now, random: () => 0 });
  try {
    const outbox = box();
    for (const [jobId, ref, commit] of [
      ['apply-1', 'main', 'a'], ['apply-2', 'main', 'b'],
      ['attempt-2', 'agent/TASK-0002', 'c'], ['attempt-3', 'agent/TASK-0003', 'd'],
    ]) {
      if (!jobId || !ref || !commit) throw new Error('시험 입력이 없습니다.');
      await reportDesignSnapshot(outbox, { epoch: 0, jobId, fence: 1, commit: commit.repeat(40), ref, branch: ref, jobKind: ref === 'main' ? 'design_apply' : 'attempt',
        files: [{ path: 'contracts/api/openapi.json', raw: '{"openapi":"3.1.0","paths":{"/u":{"get":{"responses":{}}}}}' }] });
    }
    await outbox.enqueue('reportUsage', { epoch: 0, body: { agent: 'Codex', remainPct: 50 } });
    if (legacy) {
      await state.update(draft => { for (const entry of draft.outbox) if (entry.operation === 'reportDesignSnapshot') entry.stream = 'reportDesignSnapshot'; });
      await state.close(); state = await State.open(home);
    }
    const resumed = box();
    await resumed.flush();
    expect(sent.map(s => s.job)).toEqual(['apply-1', 'attempt-2', 'attempt-3', 'usage']);
    expect(state.snapshot.outbox.map(e => e.request.body?.jobId)).toEqual(['apply-1', 'apply-2']);
    expect(resumed.readinessWarnings.join(' ')).toContain('보류');
    for (let i = 0; i < 8; i++) {
      const pending = state.snapshot.outbox[0];
      if (!pending) throw new Error('보류 보고가 사라졌습니다.');
      expect(pending.nextAt - now).toBeGreaterThan(0);
      expect(pending.nextAt - now).toBeLessThanOrEqual(60_000);
      now = pending.nextAt; await resumed.flush();
    }
    expect(sent.some(s => s.job === 'apply-2')).toBe(false);
    expect(new Set(sent.filter(s => s.job === 'apply-1').map(s => s.key)).size).toBe(1);
    hold = false;
    now = state.snapshot.outbox[0]?.nextAt ?? now;
    await resumed.flush();
    expect(sent.slice(-2).map(s => s.job)).toEqual(['apply-1', 'apply-2']);
    expect(state.snapshot.outbox).toEqual([]);
    expect(resumed.rejected).toEqual([]);
  } finally { await state.close(); await rm(home, { recursive: true, force: true }); }
});

const sql = (raw: string) => parseContracts([{ path: 'contracts/db/postgres/001.sql', raw }]);

test.each([
  "CREATE TABLE t(id integer, x integer NOT NULL); DO $$ BEGIN EXECUTE 'ALTER TABLE t DROP COLUMN x'; END $$; CREATE TABLE later(id integer);",
  'CREATE TABLE t(id integer); CALL mutate_schema(); CREATE TABLE later(id integer);',
])('P2-2 영향 범위를 모르는 SQL은 기존·이후 테이블 모두 unchecked다: %s', raw => {
  const result = sql(raw);
  expect(result.files[0]?.status).toBe('ok');
  expect(result.items.length).toBeGreaterThan(0);
  expect(result.items.every(i => i.contract === undefined)).toBe(true);
});

test('P2-2 enum 값 이름 변경은 그 타입을 쓰는 기존·이후·배열 컬럼만 unchecked다', () => {
  const result = sql("CREATE TYPE s AS ENUM ('a','b'); CREATE TABLE t(k s); CREATE TABLE arrays(k s[]); CREATE TABLE safe(id integer); ALTER TYPE s RENAME VALUE 'a' TO 'z'; ALTER TABLE t RENAME TO renamed; CREATE TABLE later(k s);");
  expect(result.files[0]?.status).toBe('ok');
  for (const key of ['postgres:renamed', 'postgres:arrays', 'postgres:later']) {
    expect(result.items.find(i => i.itemKey === key), key).toBeDefined();
    expect(result.items.find(i => i.itemKey === key)?.contract, key).toBeUndefined();
  }
  expect(result.items.find(i => i.itemKey === 'postgres:safe')?.contract?.fields).toEqual([{ path: '/id', type: 'integer', required: false }]);
});

test.each([
  ["CREATE TYPE s AS ENUM ('a');", "ALTER TYPE s ADD VALUE 'z' BEFORE 'a';"],
  ["CREATE TYPE s AS ENUM ('a');", 'ALTER TYPE s RENAME TO renamed;'],
  ['CREATE TYPE s AS (id integer);', 'ALTER TYPE s ADD ATTRIBUTE extra text;'],
])('P2-2 해석하지 못한 타입 변경은 기존·이후 사용을 대조하지 않는다: %s %s', (create, alter) => {
  const result = sql(`${create} CREATE TABLE t(k s); CREATE TABLE safe(id integer); ${alter} CREATE TABLE later(k ${alter.includes('RENAME TO') ? 'renamed' : 's'});`);
  expect(result.files[0]?.status).toBe('ok');
  for (const key of ['postgres:t', 'postgres:later']) {
    expect(result.items.find(i => i.itemKey === key), key).toBeDefined();
    expect(result.items.find(i => i.itemKey === key)?.contract, key).toBeUndefined();
  }
  expect(result.items.find(i => i.itemKey === 'postgres:safe')?.contract).toBeDefined();
});

test('P2-2 타입 이름이 바뀌어도 원래 스키마의 이후 사용을 대조하지 않는다', () => {
  const result = sql("CREATE SCHEMA private; CREATE TYPE private.s AS ENUM ('a'); CREATE TABLE t(k private.s); ALTER TYPE private.s RENAME TO renamed; CREATE TABLE later(k private.renamed); CREATE TABLE safe(k integer);");
  expect(result.files[0]?.status).toBe('ok');
  expect(result.items.find(i => i.itemKey === 'postgres:t')?.contract).toBeUndefined();
  expect(result.items.find(i => i.itemKey === 'postgres:later')?.contract).toBeUndefined();
  expect(result.items.find(i => i.itemKey === 'postgres:safe')?.contract).toBeDefined();
});

test('P2-2 모르는 ALTER의 오염은 테이블 객체를 따라가고 새로 만든 동명 테이블에는 옮기지 않는다', () => {
  const result = sql('CREATE TABLE p(id integer); CREATE TABLE t(id integer); ALTER TABLE t INHERIT p; ALTER TABLE t RENAME TO u; ALTER TABLE u RENAME COLUMN id TO key; CREATE TABLE t(id integer);');
  expect(result.files[0]?.status).toBe('ok');
  expect(result.items.find(i => i.itemKey === 'postgres:u')?.contract).toBeUndefined();
  expect(result.items.find(i => i.itemKey === 'postgres:t')?.contract?.fields).toEqual([{ path: '/id', type: 'integer', required: false }]);
  expect(result.items.find(i => i.itemKey === 'postgres:p')?.contract).toBeDefined();
});

test('P2-2 범위 불명 오염은 파일 이름순으로 다음 마이그레이션까지 유지한다', () => {
  const result = parseContracts([
    { path: 'contracts/db/postgres/003.sql', raw: 'CREATE TABLE later(id integer);' },
    { path: 'contracts/db/postgres/001.sql', raw: 'CREATE TABLE earlier(id integer);' },
    { path: 'contracts/db/postgres/002.sql', raw: "DO $$ BEGIN EXECUTE 'ALTER TABLE earlier DROP COLUMN id'; END $$;" },
  ]);
  expect(result.files.every(f => f.status === 'ok')).toBe(true);
  expect(result.items.map(i => i.itemKey)).toEqual(['postgres:earlier', 'postgres:later']);
  expect(result.items.every(i => i.contract === undefined)).toBe(true);
});

test('P2-3 객체 스키마의 type은 필수이며 구조·값으로 추측하지 않는다', () => {
  for (const schema of [{}, { description: '설명뿐' }, { items: { type: 'string' } }, { properties: { id: { type: 'string' } } },
    { required: ['id'] }, { additionalProperties: true }, { enum: ['a'] }, { const: 1 }, { $ref: '#/defs/Untyped' }]) {
    const root = { defs: { Untyped: { items: { type: 'string' } } } };
    expect(() => schemaFields(schema, root, '/body', false)).toThrow();
  }
  expect(schemaFields({ type: 'array', items: { type: 'string' } }, {}, '/body', false)).toEqual([
    { path: '/body', type: 'array', required: false }, { path: '/body/*', type: 'string', required: false },
  ]);
});

test('P2-3 중첩된 type 누락은 해당 REST·Kafka 항목만 대조 안 함으로 보고한다', async () => {
  const result = await buildDesignSnapshot({
    commit: 'a'.repeat(40), jobId: 'job', fence: 1, ref: 'main', jobKind: 'design_apply',
    files: [
      { path: 'contracts/api/openapi.json', raw: JSON.stringify({ openapi: '3.1.0', paths: {
        '/bad': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { nested: { items: { type: 'string' } } } } } } }, responses: {} } },
        '/ok': { get: { responses: {} } },
      } }) },
      { path: 'contracts/events/asyncapi.json', raw: JSON.stringify({ asyncapi: '3.0.0', servers: { k: { protocol: 'kafka' } }, channels: { c: { address: 'event', messages: { m: { payload: { properties: { id: { type: 'string' } } } } } } } }) },
    ],
  }, { openapi: async ({ item }) => item.contract, asyncapi: async ({ item }) => item.contract });
  expect(result.items.find(i => i.itemKey === 'GET /ok')?.contract).toBeDefined();
  expect(result.drifts.map(d => [d.itemKey, d.compat])).toEqual([['POST /bad', 'unchecked'], ['event', 'unchecked']]);
});
