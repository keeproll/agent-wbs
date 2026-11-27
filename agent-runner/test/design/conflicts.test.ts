import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createApiClient } from '../../src/api/client.ts';
import { Outbox } from '../../src/api/outbox.ts';
import { Secret } from '../../src/security/secret.ts';
import { State, type Entry } from '../../src/state/state.ts';
import { reportDesignSnapshot } from '../../src/design/snapshot.ts';
import { designItemHash } from '../../src/design/hash.ts';

const input = { epoch: 0, commit: 'a'.repeat(40), jobId: 'job', fence: 1, ref: 'main', jobKind: 'design_apply' as const, files: [{ path: 'contracts/api/openapi.json', raw: JSON.stringify({ openapi: '3.1.0', paths: { '/users': { get: { responses: {} } } } }) }] };

async function scenario(run: (state: State, api: ReturnType<typeof createApiClient>, reply: (code: string | null, details?: object) => void) => Promise<void>) {
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'design-conflict-'));
  const state = await State.open(home);
  let code: string | null = null, details: object = {};
  const api = createApiClient({ baseUrl: 'http://wbs.invalid', token: new Secret('fake'), fetch: async () => code ? new Response(JSON.stringify({ error: { code, message: code, details } }), { status: 409, headers: { 'content-type': 'application/json' } }) : new Response(null, { status: 204 }) });
  try { await run(state, api, (next, d = {}) => { code = next; details = d; }); }
  finally { await state.close(); await rm(home, { recursive: true, force: true }); }
}

test('M1 EXTERNAL_WRITE_BLOCKED는 pending·사람이 보는 상태를 유지하고 백오프 뒤 재시도한다', async () => scenario(async (state, api, reply) => {
  let now = 1000;
  const rejected: Entry[] = [];
  const outbox = new Outbox(state, api, { now: () => now, monotonic: () => now, random: () => 0, onRejected: e => { rejected.push(e); } });
  await reportDesignSnapshot(outbox, input);
  reply('EXTERNAL_WRITE_BLOCKED');
  await outbox.flush();
  expect(state.snapshot.outbox[0]).toMatchObject({ state: 'pending', code: 'EXTERNAL_WRITE_BLOCKED', nextAt: 2000 });
  expect(outbox.readinessWarnings.join(' ')).toContain('보류');
  expect(rejected).toEqual([]);
  now = 2000; reply(null); await outbox.flush();
  expect(state.snapshot.outbox).toEqual([]);
}));

test('M1 INVALID_TRANSITION은 jobId·fence·원인을 호출자에게 알리고 중지한다', async () => scenario(async (state, api, reply) => {
  const rejected: Entry[] = [];
  const outbox = new Outbox(state, api, { onRejected: e => { rejected.push(e); } });
  await reportDesignSnapshot(outbox, input); reply('INVALID_TRANSITION'); await outbox.flush(); await outbox.flush();
  expect(state.snapshot.outbox).toEqual([]);
  expect(rejected).toMatchObject([{ code: 'INVALID_TRANSITION', request: { body: { jobId: 'job', fence: 1 } } }]);
}));

test.each([true, false])('M1 VERSION_CONFLICT는 서버 hash가 같으면 성공, 다르면 중지한다 (같음=%s)', async same => scenario(async (state, api, reply) => {
  const rejected: Entry[] = [];
  const outbox = new Outbox(state, api, { onRejected: e => { rejected.push(e); } });
  const entry = await reportDesignSnapshot(outbox, input);
  const item = (entry.request.body?.items as object[])[0];
  reply('VERSION_CONFLICT', { conflicts: [{ itemKey: 'GET /users', serverState: 'checked', serverContentHash: same ? designItemHash(item) : '0'.repeat(64), commit: input.commit, ref: input.ref }] });
  await outbox.flush();
  expect(state.snapshot.outbox).toEqual([]);
  if (same) expect(rejected).toEqual([]);
  else expect(rejected[0]).toMatchObject({ code: 'VERSION_CONFLICT', reason: expect.stringContaining('서버와 불일치') });
}));

test('내용 hash는 필드 순서와 선택값 생략을 정규화하고 실제 차이는 유지한다', () => {
  const field = { path: '/id', type: 'string', required: true }, other = { path: '/name', type: 'string', required: false };
  const base = { itemKey: 'GET /u', kind: 'REST', path: 'contracts/a.json', content: {}, contract: { fields: [field, other] } };
  expect(designItemHash(base)).toBe(designItemHash({ ...base, name: null, taskKey: null, extracted: null, contract: { fields: [other, field] } }));
  expect(designItemHash(base)).not.toBe(designItemHash({ ...base, content: { changed: true } }));
  expect(designItemHash({ ...base, content: { rules: ['first', 'second'] } })).not.toBe(designItemHash({ ...base, content: { rules: ['second', 'first'] } }));
});
