import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Outbox } from '../../src/api/outbox.ts';
import { createApiClient } from '../../src/api/client.ts';
import { State, type Entry } from '../../src/state/state.ts';
import { Secret } from '../../src/security/secret.ts';

const DAY = 86400_000;
let now: number;
let home: string;
let state: State;
const entry = (target: string, body: Record<string, unknown> = {}, at = now): Entry => ({
  id: randomUUID(), operation: 'reportCommandResult', request: { epoch: 0, idempotencyKey: `command:r:${randomUUID()}`, params: { id: target }, body },
  stream: 'reportCommandResult', state: 'rejected', attempts: 1, nextAt: 0, status: 409, code: 'INVALID_TRANSITION', reason: '증거 불일치', rejectedAt: at,
});
const rawFiles = async () => (await readdir(join(home, 'state/rejected'))).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
const reopen = async (limits = {}) => { await state.close(); state = await State.open(home, { now: () => now, rejectionLimits: limits }); };

beforeEach(async () => {
  now = Date.UTC(2026, 10, 26);
  const root = process.env.AWBS_TEST_TMP ?? tmpdir();
  await mkdir(root, { recursive: true });
  home = await mkdtemp(join(root, 'retention-test-'));
  state = await State.open(home, { now: () => now });
});
afterEach(async () => { await state.close(); await rm(home, { recursive: true, force: true }); });

test('N1 같은 명령·오류는 파일 하나에 횟수·첫/마지막 시각·마지막 요청 해시로 묶는다', async () => {
  for (let i = 0; i < 10; i++) { await state.reject(entry('c1', { attempt: i })); now += 1000; }
  expect(await rawFiles()).toHaveLength(1);
  expect(state.rejected).toMatchObject([{ count: 10, firstAt: now - 10_000, lastAt: now - 1000, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  await reopen();
  expect(state.rejected[0]?.count).toBe(10);
});

test('N2 깨진 거부 기록은 격리하고 핵심 상태는 계속 연다', async () => {
  await state.reject(entry('good'));
  const id = randomUUID();
  await state.close();
  await writeFile(join(home, 'state/rejected', `${id}.json`), '{broken');
  await expect(reopen()).resolves.toBeUndefined();
  expect(await readdir(join(home, 'state/rejected/corrupt'))).toContain(`${id}.json`);
  expect(state.rejectionStatus.corrupt).toBe(1);
  expect(state.rejectionAlerts).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CORRUPT_REJECTION' })]));
  expect(state.snapshot.epoch).toBe(0);
});

test('N3 원문 501건이면 가장 오래된 한 건을 요약하고 총 건수를 보존한다', async () => {
  const records = Array.from({ length: 501 }, (_, i) => entry(`c${String(i)}`, { note: '원문' }, now - 2 * DAY + i));
  await state.close();
  await Promise.all(records.map((r) => writeFile(join(home, 'state/rejected', `${r.id}.json`), JSON.stringify(r))));
  await reopen();
  expect(await rawFiles()).toHaveLength(500);
  expect(state.rejectionStatus).toMatchObject({ total: 501, kept: 500, summarized: 1 });
  expect(await rawFiles()).not.toContain(`${records[0]?.id ?? ''}.json`);
  expect(JSON.parse(await readFile(join(home, 'state/rejected/summary.json'), 'utf8'))).toMatchObject({ records: 1, events: 1 });
  expect(state.rejectionAlerts).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REJECTION_SUMMARIZED' })]));
});

test('N3 크기·30일 기간 한도를 넘으면 원문 대신 원인 요약을 남긴다', async () => {
  await reopen({ maxBytes: 1500 });
  await state.reject(entry('old', { note: 'a'.repeat(500) }, now - 2 * DAY));
  await state.reject(entry('new', { note: 'b'.repeat(500) }, now - DAY));
  expect(state.rejectionStatus.bytes).toBeLessThanOrEqual(1500);
  expect(state.rejectionStatus.summarized).toBeGreaterThan(0);
  now += 31 * DAY;
  await state.maintainRejections();
  expect(await rawFiles()).toEqual([]);
  expect(state.rejectionStatus.total).toBe(2);
  expect(state.rejectionStatus.summarized).toBe(2);
});

test('N3 원문 1건은 64 KiB를 넘지 않고 큰 필드는 앞 4 KiB·해시·길이로 남긴다', async () => {
  await state.reject(entry('large', { note: '민감한 긴 내용'.repeat(10000) }));
  const [name] = await rawFiles();
  expect((await stat(join(home, 'state/rejected', name ?? ''))).size).toBeLessThanOrEqual(64 * 1024);
  const raw = await state.readRejection(state.rejected[0]?.id ?? '');
  expect(raw?.request.body?.note).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/), length: expect.any(Number), preview: expect.any(String) });
  expect(Buffer.byteLength(String((raw?.request.body?.note as { preview: string }).preview))).toBeLessThanOrEqual(4096);
  expect(JSON.stringify(state.rejected)).not.toContain('민감한 긴 내용');
});

test('N3 조회·enqueue는 원문 전체 복사 없이 색인과 키 지도를 쓴다', async () => {
  await state.reject(entry('c1', { note: '원문으로만 보관할 내용' }));
  const api = createApiClient({ baseUrl: 'http://127.0.0.1:1', token: new Secret('x'.repeat(32)) });
  const outbox = new Outbox(state, api);
  Object.defineProperty(state, 'rejected', { get: () => { throw new Error('전체 복사 금지'); } });
  await expect(outbox.enqueue('reportUsage', { epoch: 0, body: { agent: 'Codex', remainPct: 80 } })).resolves.toBeDefined();
  expect(outbox.readinessWarnings.join(' ')).toContain('1');
});

test('N3 고정 보관 시도는 우선 남기며 요약 뒤에도 차단 근거를 잃지 않는다', async () => {
  await reopen({ maxRecords: 1 });
  const pinned = { ...entry('a', { fence: 7 }), operation: 'reportAttemptStatus' as const, stream: 'attempt:a', code: 'LEASE_LOST', request: {
    epoch: 0, idempotencyKey: 'att:a:status:2026-11-26T00:00:00Z', params: { attemptId: 'a' }, body: { fence: 7 },
  } };
  await state.reject(pinned);
  await state.reject(entry('ordinary', {}, now + 1));
  expect((await rawFiles())).toContain(`${pinned.id}.json`);
  expect(state.rejectionStatus.pinned).toBe(1);
  now += 31 * DAY;
  await state.maintainRejections();
  await reopen({ maxRecords: 1 });
  const outbox = new Outbox(state, createApiClient({ baseUrl: 'http://127.0.0.1:1', token: new Secret('x'.repeat(32)) }));
  expect(outbox.rejectedFor('a')).toMatchObject([{ code: 'LEASE_LOST', request: { body: { fence: 7 } } }]);
  expect(state.rejectionStatus.total).toBe(2);
});
