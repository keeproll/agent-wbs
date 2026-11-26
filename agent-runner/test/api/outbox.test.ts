import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createApiClient } from '../../src/api/client.ts';
import { Outbox } from '../../src/api/outbox.ts';
import { Runner } from '../../src/api/runner.ts';
import { State } from '../../src/state/state.ts';
import { Secret } from '../../src/security/secret.ts';

const archive = process.env.AWBS_TEST_TMP ?? tmpdir();
const token = 'fake-runner-token-0123456789abcdef';
interface Request { path: string; headers: IncomingMessage['headers']; body: Record<string, unknown>; raw: Buffer }
let home: string;
let server: Server;
let url: string;
let state: State;
let outbox: Outbox;
let requests: Request[];
let now: number;
let handle: (req: Request, res: ServerResponse) => void;
const json = (res: ServerResponse, body: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const fail = (res: ServerResponse, status: number, code = 'VALIDATION_FAILED', details = {}) => json(res, {
  error: { code, message: '시험 오류', action: '보고', fix: '확인', errors: [], details, requestId: 'fake' },
}, status);
const api = () => createApiClient({ baseUrl: url, token: new Secret(token) });
const usage = () => outbox.enqueue('reportUsage', { epoch: 0, body: { agent: 'Codex', remainPct: 60 } });
const status = (attemptId: string) => outbox.enqueue('reportAttemptStatus', {
  epoch: 0, params: { attemptId }, body: { fence: 1, status: 'running', at: new Date(now).toISOString(), model: 'fake', effort: 'low' },
});

beforeEach(async () => {
  await mkdir(archive, { recursive: true });
  home = await mkdtemp(join(archive, 'state-test-'));
  requests = [];
  now = 1_000_000;
  handle = (_req, res) => res.writeHead(204).end();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const request: Request = {
        path: req.url ?? '', headers: req.headers, raw,
        body: req.headers['content-type'] === 'application/json' ? JSON.parse(raw.toString()) as Record<string, unknown> : {},
      };
      requests.push(request);
      handle(request, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  state = await State.open(home);
  outbox = new Outbox(state, api(), { now: () => now, monotonic: () => now, random: () => 0 });
});
afterEach(async () => {
  await state.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});

const reopen = async () => { await state.close(); state = await State.open(home); return state; };

test('보고를 먼저 원자 저장하고 재시작해도 키·본문·Runner 식별자를 유지한다', async () => {
  const entry = await usage();
  expect(requests).toHaveLength(0);
  const restored = await reopen();
  expect(restored.snapshot.runnerId).toBe(state.snapshot.runnerId);
  expect(restored.snapshot.outbox[0]).toMatchObject({ id: entry.id, request: { idempotencyKey: entry.request.idempotencyKey } });
  expect((await stat(join(home, 'state/runner.json'))).mode & 0o777).toBe(0o600);
  await new Outbox(restored, api()).flush();
  expect(requests[0]?.headers['idempotency-key']).toBe(entry.request.idempotencyKey);
  expect(restored.snapshot.outbox).toEqual([]);
  expect(await readFile(join(home, 'state/runner.json'), 'utf8')).not.toContain(token);
});

test.each([408, 429, 500, 503, 599])('%s는 무기한 재시도하며 Retry-After·동일 키를 지킨다', async (code) => {
  handle = (_req, res) => { res.setHeader('retry-after', '7'); fail(res, code); };
  const entry = await usage();
  await outbox.flush();
  expect(state.snapshot.outbox[0]).toMatchObject({ state: 'pending', attempts: 1, nextAt: now + 7000 });
  await outbox.flush();
  expect(requests).toHaveLength(1);
  now += 7000;
  handle = (_req, res) => res.writeHead(204).end();
  await outbox.flush();
  expect(requests.map((req) => req.headers['idempotency-key'])).toEqual([entry.request.idempotencyKey, entry.request.idempotencyKey]);
  expect(state.snapshot.outbox).toEqual([]);
});

test('네트워크 단절은 재시도하고 백오프는 1초부터 60초까지 증가한다', async () => {
  handle = (_req, res) => res.destroy();
  await usage();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    await outbox.flush();
    expect(state.snapshot.outbox[0]?.nextAt).toBe(now + delay);
    now += delay;
  }
  expect(state.snapshot.outbox[0]?.attempts).toBe(8);
});

test('백오프의 jitter와 날짜 형식 Retry-After도 지킨다', async () => {
  handle = (_req, res) => { res.setHeader('retry-after', new Date(now + 10_000).toUTCString()); fail(res, 429); };
  await usage();
  await new Outbox(state, api(), { now: () => now, monotonic: () => now, random: () => 0.5 }).flush();
  expect(state.snapshot.outbox[0]?.nextAt).toBe(now + 10_000);
  now += 10_000;
  handle = (_req, res) => fail(res, 503);
  await new Outbox(state, api(), { now: () => now, monotonic: () => now, random: () => 0.5 }).flush();
  expect(state.snapshot.outbox[0]?.nextAt).toBe(now + 2200);
});

test('로컬 요청 검증 오류는 네트워크 단절처럼 재시도하지 않는다', async () => {
  await status('.');
  await outbox.flush();
  expect(requests).toHaveLength(0);
  expect(outbox.rejected[0]).toMatchObject({ state: 'rejected', code: 'INVALID_REQUEST' });
});

test('같은 시도의 뒤 보고는 보류하고 다른 시도의 보고는 보낸다', async () => {
  handle = (req, res) => req.path.includes('/a/') ? fail(res, 503) : res.writeHead(204).end();
  await status('a');
  await outbox.enqueue('reportAttemptResult', { epoch: 0, params: { attemptId: 'a' }, body: { fence: 1, summary: '완료', changedFiles: [], evidence: [] } });
  await status('b');
  await Promise.all([outbox.flush(), outbox.flush()]);
  expect(requests.map((req) => req.path)).toEqual(['/api/runner/attempts/a/status', '/api/runner/attempts/b/status']);
  expect(state.snapshot.outbox).toHaveLength(2);
});

test.each([400, 404, 409, 422, 600])('%s는 rejected로 보존하고 같은 시도 뒤 보고를 막으며 준비 상태 경고를 남긴다', async (code) => {
  handle = (_req, res) => fail(res, code);
  await status('a');
  await outbox.enqueue('reportAttemptResult', { epoch: 0, params: { attemptId: 'a' }, body: { fence: 1, summary: '완료', changedFiles: [], evidence: [] } });
  await outbox.flush();
  now += 1_000_000;
  await outbox.flush();
  expect(requests).toHaveLength(1);
  expect(outbox.rejected[0]).toMatchObject({ state: 'rejected', status: code });
  expect(outbox.readinessWarnings).toHaveLength(1);
});

test.each([401, 403])('%s는 Runner를 중지시키고 뒤 요청을 보내지 않는다', async (code) => {
  handle = (_req, res) => fail(res, code, 'RUNNER_UNAUTHORIZED');
  await usage();
  await status('b');
  await expect(outbox.flush()).rejects.toMatchObject({ status: code });
  expect(requests).toHaveLength(1);
});

test('multipart 증거 파일도 디스크에서 복구해 같은 바이트로 보낸다', async () => {
  const bytes = new Uint8Array([0, 255, 1, 2]);
  await outbox.enqueue('uploadEvidence', { epoch: 0, params: { attemptId: 'a' }, body: {
    file: new Blob([bytes], { type: 'application/octet-stream' }), kind: 'log', fence: 1, sha256: 'a'.repeat(64), size: bytes.length,
  } });
  handle = (_req, res) => json(res, { id: 'e', sha256: 'a'.repeat(64), size: bytes.length }, 201);
  await new Outbox(await reopen(), api()).flush();
  const req = requests[0];
  const form = await new Response(new Uint8Array(req?.raw ?? []), { headers: { 'content-type': req?.headers['content-type'] ?? '' } }).formData();
  expect(new Uint8Array(await (form.get('file') as File).arrayBuffer())).toEqual(bytes);
});

test('같은 시각·시도의 서로 다른 증거 파일은 멱등 키가 충돌하지 않는다', async () => {
  await Promise.all(['첫째', '둘째'].map((text) => outbox.enqueue('uploadEvidence', {
    epoch: 0, params: { attemptId: 'a' }, body: { file: new Blob([text]), kind: 'log', fence: 1, sha256: createHash('sha256').update(text).digest('hex'), size: 6 },
  })));
  expect(new Set(state.snapshot.outbox.map((entry) => entry.request.idempotencyKey)).size).toBe(2);
});

const idle = (req: Request, res: ServerResponse) => {
  if (req.path.endsWith('commands')) json(res, { currentEpoch: 0, commands: [] });
  else if (req.path.endsWith('policy')) json(res, { heartbeatSeconds: 60 });
  else if (req.path.endsWith('messages')) json(res, { messages: [], nextCursor: null });
  else res.writeHead(204).end();
};

test('리뷰 H2: 거부된 세션 보고는 별도 보존하고 새 세션 보고를 보내며 원인을 조회한다', async () => {
  const session = { epoch: 0, body: { runnerId: 'r', event: 'stop' as const, at: new Date(now).toISOString() } };
  await outbox.enqueue('reportSession', session);
  handle = (_req, res) => fail(res, 409, 'INVALID_TRANSITION');
  await outbox.flush();
  await outbox.enqueue('reportSession', { ...session, body: { ...session.body, event: 'start' } });
  handle = (_req, res) => res.writeHead(204).end();
  await outbox.flush();
  expect(requests).toHaveLength(2);
  expect(state.snapshot.outbox).toEqual([]);
  expect(outbox.rejected).toMatchObject([{ status: 409, code: 'INVALID_TRANSITION', reason: '시험 오류', fix: '확인', request: { body: { event: 'stop' } } }]);
  expect(await readdir(join(home, 'state/rejected'))).toHaveLength(1);
});

test('리뷰 H1: 명령 결과가 409로 거부되면 최신 명령을 다시 처리해 초기화를 끝낸다', async () => {
  let attempts = 0;
  let cleanups = 0;
  handle = (req, res) => {
    if (req.path.endsWith('commands')) json(res, { currentEpoch: 1, commands: attempts >= 2 ? [] : commands });
    else if (req.path.endsWith('/result')) { attempts++; if (attempts === 1) fail(res, 409, 'INVALID_TRANSITION'); else res.writeHead(204).end(); }
    else idle(req, res);
  };
  const r = runner(async () => { cleanups++; return { status: 'done', items: [], holds: [] }; });
  await r.poll();
  await r.poll();
  await r.poll();
  expect(cleanups).toBe(2);
  expect(r.ready).toBe(true);
  expect(state.snapshot.epoch).toBe(1);
  expect(r.outbox.rejected).toMatchObject([{ status: 409 }]);
  const keys = requests.filter((req) => req.path.endsWith('/result')).map((req) => req.headers['idempotency-key']);
  expect(new Set(keys).size).toBe(2);
});

test('리뷰 M1: 같은 폴더를 두 번째로 여는 Runner는 시작을 거부한다', async () => {
  await expect(State.open(home)).rejects.toMatchObject({ name: 'StateLockError' });
});

test('리뷰 M2: LEASE_LOST를 실행 계층에 알리고 재시작 조회에도 남긴다', async () => {
  const rejected: string[] = [];
  outbox = new Outbox(state, api(), { onRejected: (entry) => { rejected.push(entry.code ?? ''); } });
  await status('a');
  handle = (_req, res) => fail(res, 409, 'LEASE_LOST');
  await outbox.flush();
  expect(rejected).toEqual(['LEASE_LOST']);
  expect(outbox.rejectedFor('a')).toMatchObject([{ code: 'LEASE_LOST', request: { params: { attemptId: 'a' }, body: { fence: 1 } } }]);
  await reopen();
  outbox = new Outbox(state, api());
  expect(outbox.rejectedFor('a')).toMatchObject([{ code: 'LEASE_LOST' }]);
  await outbox.enqueue('reportAttemptResult', { epoch: 0, params: { attemptId: 'a' }, body: { fence: 1, summary: '완료', changedFiles: [], evidence: [] } });
  await outbox.flush();
  expect(requests).toHaveLength(1);
  expect(state.snapshot.outbox).toHaveLength(1);
});

test('리뷰 L1·L2: 잠금 뒤 남은 임시 파일을 지우고 기존 폴더 권한도 제한한다', async () => {
  await state.close();
  await writeFile(join(home, 'state/crash.tmp'), '민감한 임시 내용');
  await chmod(join(home, 'state'), 0o755);
  await chmod(join(home, 'state/evidence'), 0o755);
  await writeFile(join(home, 'state/runner.json'), '{broken');
  await expect(State.open(home)).rejects.toThrow(SyntaxError);
  expect((await readdir(join(home, 'state'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  expect((await stat(join(home, 'state'))).mode & 0o777).toBe(0o700);
  expect((await stat(join(home, 'state/evidence'))).mode & 0o777).toBe(0o700);
  expect(await readFile(join(home, 'state/runner.json'), 'utf8')).toBe('{broken');
});

test('이전 버전의 거부 기록과 인라인 증거도 재시작 때 별도 보관한다', async () => {
  const entry = await usage();
  await outbox.enqueue('uploadEvidence', { epoch: 0, params: { attemptId: 'a' }, body: {
    file: new Blob(['증거']), kind: 'log', fence: 1, sha256: 'a'.repeat(64), size: 6,
  } });
  const legacy = state.snapshot;
  legacy.outbox[0] = { ...entry, state: 'rejected', code: 'VALIDATION_FAILED', status: 400 };
  await state.close();
  await writeFile(join(home, 'state/runner.json'), JSON.stringify({ ...legacy, outbox: legacy.outbox.map((e) => e.file
    ? { ...e, file: { base64: Buffer.from('증거').toString('base64'), type: '' } } : e) }));
  await reopen();
  expect(state.snapshot.outbox).toHaveLength(1);
  expect(state.snapshot.outbox[0]?.file?.name).toBe(legacy.outbox[1]?.id);
  expect(state.rejected).toMatchObject([{ code: 'VALIDATION_FAILED' }]);
  expect(await readFile(join(home, 'state/runner.json'), 'utf8')).not.toContain('base64');
});

test('이전 상태의 증거 경로도 검증을 마친 뒤에만 변환한다', async () => {
  const entry = await usage();
  const legacy = { ...state.snapshot, outbox: [{ ...entry, id: '../escaped', file: { base64: Buffer.from('민감한 내용').toString('base64'), type: '' } }] };
  await state.close();
  await writeFile(join(home, 'state/runner.json'), JSON.stringify(legacy));
  await expect(State.open(home)).rejects.toThrow();
  await expect(stat(join(home, 'state/escaped'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('이전 버전의 상한 초과 증거도 바이트를 옮기지 않고 원인을 보관한다', async () => {
  await outbox.enqueue('uploadEvidence', { epoch: 0, params: { attemptId: 'a' }, body: {
    file: new Blob(), kind: 'log', fence: 1, sha256: 'a'.repeat(64), size: 0,
  } });
  const legacy = state.snapshot;
  const base64 = 'A'.repeat(Math.ceil((50 * 1024 * 1024 + 1) / 3) * 4);
  await state.close();
  await writeFile(join(home, 'state/runner.json'), JSON.stringify({ ...legacy, outbox: legacy.outbox.map((entry) => ({
    ...entry, file: { base64, type: '' },
  })) }));
  await reopen();
  expect(state.snapshot.outbox).toEqual([]);
  expect(state.rejected).toMatchObject([{ code: 'EVIDENCE_TOO_LARGE' }]);
  expect(await readdir(join(home, 'state/evidence'))).toEqual([]);
  expect((await stat(join(home, 'state/runner.json'))).size).toBeLessThan(1000);
});

test('리뷰 M3: 변화 없는 polling은 상태 파일을 다시 쓰지 않는다', async () => {
  handle = idle;
  const r = runner();
  await r.poll();
  const before = await stat(join(home, 'state/runner.json'));
  await r.poll();
  const after = await stat(join(home, 'state/runner.json'));
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
});

test('리뷰 M3: 증거 크기는 읽기 전에 제한하고 본문은 상태 JSON과 분리한다', async () => {
  const tooLarge = new Blob();
  Object.defineProperty(tooLarge, 'size', { value: 50 * 1024 * 1024 + 1 });
  await expect(outbox.enqueue('uploadEvidence', { epoch: 0, params: { attemptId: 'a' }, body: {
    file: tooLarge, kind: 'log', fence: 1, sha256: 'a'.repeat(64), size: tooLarge.size,
  } })).rejects.toThrow('50');
  await outbox.enqueue('uploadEvidence', { epoch: 0, params: { attemptId: 'a' }, body: {
    file: new Blob(['증거']), kind: 'log', fence: 1, sha256: 'a'.repeat(64), size: 6,
  } });
  expect(await readFile(join(home, 'state/runner.json'), 'utf8')).not.toContain(Buffer.from('증거').toString('base64'));
  expect(await readdir(join(home, 'state/evidence'))).toHaveLength(1);
});

test('리뷰 L2: 거부된 증거 원문은 지우고 메타데이터와 원인은 보존한다', async () => {
  const text = '민감한 증거 내용';
  await outbox.enqueue('uploadEvidence', { epoch: 0, params: { attemptId: 'a' }, body: {
    file: new Blob([text]), kind: 'log', fence: 1, sha256: 'a'.repeat(64), size: Buffer.byteLength(text),
  } });
  handle = (_req, res) => fail(res, 400);
  await outbox.flush();
  expect(state.snapshot.outbox).toEqual([]);
  expect(outbox.rejected).toMatchObject([{ code: 'VALIDATION_FAILED', request: { body: { sha256: 'a'.repeat(64) } } }]);
  expect(await readdir(join(home, 'state/evidence'))).toEqual([]);
  const files = await readdir(join(home, 'state/rejected'));
  const record = await readFile(join(home, 'state/rejected', files[0] ?? ''), 'utf8');
  expect(record).not.toContain(Buffer.from(text).toString('base64'));
});

test('리뷰 M4: 큰 Retry-After도 계약의 최대 60초까지만 기다린다', async () => {
  handle = (_req, res) => { res.setHeader('retry-after', '86400'); fail(res, 503); };
  await usage();
  await outbox.flush();
  expect(state.snapshot.outbox[0]?.nextAt).toBe(now + 60_000);
});

test('리뷰 M4: 벽시계가 뒤로 가도 단조 시계로 재시도한다', async () => {
  let monotonic = 0;
  outbox = new Outbox(state, api(), { now: () => now, monotonic: () => monotonic, random: () => 0 });
  await usage();
  handle = (_req, res) => fail(res, 503);
  await outbox.flush();
  now -= 3_600_000;
  monotonic += 1001;
  handle = (_req, res) => res.writeHead(204).end();
  await outbox.flush();
  expect(requests).toHaveLength(2);
});

test('리뷰 M4: 재시작 때 먼 미래 대기도 60초 이내로 줄인다', async () => {
  const entry = await usage();
  await state.update((draft) => { if (draft.outbox[0]) draft.outbox[0].nextAt = now + 86400_000; });
  await reopen();
  let monotonic = 0;
  outbox = new Outbox(state, api(), { now: () => now, monotonic: () => monotonic });
  await outbox.flush();
  expect(requests).toHaveLength(0);
  expect(state.snapshot.outbox[0]?.nextAt).toBe(now + 60_000);
  monotonic = 60_001;
  await outbox.flush();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.headers['idempotency-key']).toBe(entry.request.idempotencyKey);
});

test('다른 epoch의 거부 이력은 보존하되 새 시도를 차단하지 않는다', async () => {
  await status('a');
  handle = (_req, res) => fail(res, 409, 'LEASE_LOST');
  await outbox.flush();
  await state.observeEpoch(1);
  await state.update((draft) => { draft.epoch = 1; draft.pendingEpoch = null; });
  await outbox.enqueue('reportAttemptStatus', { epoch: 1, params: { attemptId: 'a' }, body: { fence: 2, status: 'running', at: new Date(now).toISOString(), model: 'fake', effort: 'low' } });
  handle = (_req, res) => res.writeHead(204).end();
  await outbox.flush();
  expect(requests).toHaveLength(2);
  expect(outbox.rejected).toHaveLength(1);
  expect(outbox.rejectedFor('a')).toEqual([]);
});

test('리뷰 M5: 시도 키는 계약 형식을 쓰며 같은 이벤트를 중복해서 쌓지 않는다', async () => {
  await status('a');
  await status('a');
  expect(state.snapshot.outbox).toHaveLength(1);
  expect(state.snapshot.outbox[0]?.request.idempotencyKey).toBe(`att:a:reportAttemptStatus-running:${new Date(now).toISOString()}`);
  await outbox.enqueue('reportUsage', { epoch: 0, idempotencyKey: 'night:2026-11-26', body: { agent: 'Codex', remainPct: 60 } });
  expect(state.snapshot.outbox[1]?.request.idempotencyKey).toBe('night:2026-11-26');
  await expect(outbox.enqueue('reportUsage', { epoch: 0, idempotencyKey: 'night:2026-11-26', body: { agent: 'Codex', remainPct: 50 } })).rejects.toThrow('다른');
});

test('리뷰 L4: epoch 오류 본문에 번호가 없어도 전송을 멈추고 명령 조회로 복구한다', async () => {
  await usage();
  handle = (_req, res) => fail(res, 409, 'EPOCH_MISMATCH');
  await expect(outbox.flush()).resolves.toBeUndefined();
  expect(state.snapshot.pendingEpoch).not.toBeNull();
  handle = (req, res) => req.path.endsWith('commands') ? json(res, { currentEpoch: 1, commands: [] }) : idle(req, res);
  await runner().poll();
  expect(state.snapshot).toMatchObject({ epoch: 1, pendingEpoch: null, outbox: [] });
});

test('동시에 쌓은 보고를 잃지 않고 손상된 상태 파일은 덮어쓰지 않는다', async () => {
  await Promise.all(Array.from({ length: 20 }, () => usage()));
  expect((await reopen()).snapshot.outbox).toHaveLength(20);
  await writeFile(join(home, 'state/runner.json'), '{broken');
  await state.close();
  await expect(State.open(home)).rejects.toThrow(SyntaxError);
  expect(await readFile(join(home, 'state/runner.json'), 'utf8')).toBe('{broken');
});

test('서버 처리 직후 kill -9하고 재시작해도 실제 처리는 한 번이다', async () => {
  const accepted = new Set<string>();
  let effects = 0;
  let first: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => { first = resolve; });
  handle = (req, res) => {
    const key = String(req.headers['idempotency-key']);
    if (!accepted.has(key)) { accepted.add(key); effects++; }
    if (requests.length === 1) first?.();
    else res.writeHead(204, { 'idempotency-replayed': 'true' }).end();
  };
  const launch = (mode: string) => spawn(process.execPath, [join(import.meta.dirname, '../helpers/outbox-worker.ts'), home, url, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  await state.close();
  const child = launch('enqueue');
  try {
    await arrived;
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    expect(await closed).toEqual([null, 'SIGKILL']);
    const replay = launch('replay');
    expect((await once(replay, 'close'))[0]).toBe(0);
    expect(effects).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers['idempotency-key']).toBe(requests[1]?.headers['idempotency-key']);
    expect((await reopen()).snapshot.outbox).toEqual([]);
  } finally { child.kill('SIGKILL'); }
});

const runner = (cleanup?: ConstructorParameters<typeof Runner>[0]['cleanup']) => new Runner({ state, api: api(), version: 'test', now: () => now, monotonic: () => now, ...(cleanup && { cleanup }) });
const commands = [{ id: 'reset-1', kind: 'reset-cleanup', epoch: 1, payload: {} }];
test('epoch 불일치는 옛 보고를 버리고 정리 결과 수신 확인 뒤에만 새 번호를 저장한다', async () => {
  let clean = false;
  let result = false;
  handle = (req, res) => {
    if (req.path === '/api/runner/commands') json(res, { currentEpoch: 2, commands: result ? [] : commands });
    else if (req.path.endsWith('/result')) {
      expect(req.headers['x-project-epoch']).toBe('1');
      expect(state.snapshot.epoch).toBe(0);
      if (!clean) fail(res, 503); else { result = true; res.writeHead(204).end(); }
    } else if (result) idle(req, res);
    else fail(res, 409, 'EPOCH_MISMATCH', { currentEpoch: 2 });
  };
  await usage();
  await outbox.flush();
  expect(state.snapshot).toMatchObject({ epoch: 0, pendingEpoch: 2, outbox: [] });
  await expect(usage()).rejects.toThrow();
  const r = runner(async () => ({ status: 'done', items: [], holds: [] }));
  await r.poll();
  expect(state.snapshot.epoch).toBe(0);
  clean = true;
  now += 60_000;
  await r.poll();
  await r.poll();
  expect(state.snapshot).toMatchObject({ epoch: 2, pendingEpoch: null, cursor: null });
});

test('정리 구현이 없거나 실패하면 새 epoch와 메시지로 진행하지 않는다', async () => {
  handle = (req, res) => {
    expect(req.path).toBe('/api/runner/commands');
    json(res, { currentEpoch: 1, commands });
  };
  await runner().poll();
  expect(state.snapshot).toMatchObject({ epoch: 0, pendingEpoch: 1 });
  expect(requests).toHaveLength(1);
  expect(runner().readinessWarnings.length).toBeGreaterThan(0);
});

test('최초 명령 확인 전에는 준비 완료로 표시하지 않는다', () => {
  expect(runner().ready).toBe(false);
});

test('정책 응답을 기다리는 동안 초기화되면 옛 epoch로 메시지를 조회하지 않는다', async () => {
  let policyResponse: ServerResponse | undefined;
  let waiting: (() => void) | undefined;
  const policyRequested = new Promise<void>((resolve) => { waiting = resolve; });
  handle = (req, res) => {
    if (req.path.endsWith('commands')) json(res, { currentEpoch: 0, commands: [] });
    else if (req.path.endsWith('policy')) { policyResponse = res; waiting?.(); }
    else if (req.path.endsWith('heartbeat')) res.writeHead(204, { 'x-current-epoch': '1' }).end();
    else json(res, { messages: [], nextCursor: null });
  };
  const r = runner();
  const polling = r.poll();
  await policyRequested;
  await r.heartbeat();
  if (!policyResponse) throw new Error('정책 요청이 없습니다.');
  json(policyResponse, { heartbeatSeconds: 60 });
  await polling;
  expect(requests.some((req) => req.path.includes('/messages'))).toBe(false);
  expect(state.snapshot).toMatchObject({ epoch: 0, pendingEpoch: 1 });
});

test('이전 명령 조회가 더 늦게 도착해도 새 초기화 번호를 되돌리지 않는다', async () => {
  await state.observeEpoch(1);
  handle = (req, res) => req.path.endsWith('commands') ? json(res, { currentEpoch: 0, commands: [] }) : res.writeHead(204).end();
  await expect(runner().poll()).rejects.toThrow('뒤로');
  expect(state.snapshot).toMatchObject({ epoch: 0, pendingEpoch: 1 });
});

test('정리 작업이 기다리는 동안에도 생존 신호를 별도로 계속 보낸다', async () => {
  let release: (() => void) | undefined;
  const cleanupWait = new Promise<void>((resolve) => { release = resolve; });
  let beats = 0;
  let enough: (() => void) | undefined;
  const twoBeats = new Promise<void>((resolve) => { enough = resolve; });
  handle = (req, res) => {
    if (req.path.endsWith('commands')) json(res, { currentEpoch: 1, commands });
    else if (req.path.endsWith('heartbeat')) {
      beats++;
      res.writeHead(204, { 'x-current-epoch': '1' }).end();
      if (beats === 2) enough?.();
    } else res.writeHead(204).end();
  };
  const r = runner(async () => { await cleanupWait; return { status: 'done', items: [], holds: [] }; });
  r.heartbeatSeconds = 0.01;
  const controller = new AbortController();
  const running = r.run(controller.signal);
  try {
    await twoBeats;
    expect(beats).toBeGreaterThanOrEqual(2);
    expect(requests.some((req) => req.path.endsWith('/result'))).toBe(false);
  } finally {
    controller.abort();
    release?.();
    await running;
  }
});

test('인증 실패는 생존 신호와 polling 반복을 함께 끝낸다', async () => {
  handle = (_req, res) => fail(res, 401, 'RUNNER_UNAUTHORIZED');
  await expect(runner().run(new AbortController().signal)).rejects.toMatchObject({ status: 401 });
  expect(requests.length).toBeLessThanOrEqual(2);
  expect(requests.every((req) => !req.path.endsWith('sessions'))).toBe(true);
});

test('같은 epoch 정리 명령도 먼저 처리하고 실패 결과를 성공으로 바꾸지 않는다', async () => {
  let reported = false;
  handle = (req, res) => {
    if (req.path.endsWith('commands')) json(res, { currentEpoch: 0, commands: [{ ...commands[0], epoch: 0 }] });
    else { reported = true; expect(req.body.status).toBe('failed'); res.writeHead(204).end(); }
  };
  const r = runner(async () => ({ status: 'failed', items: [{ name: '정리', ok: false, detail: '시험 실패' }] }));
  await r.poll();
  expect(reported).toBe(true);
  expect(r.ready).toBe(false);
  expect(state.snapshot).toMatchObject({ epoch: 0, pendingEpoch: 0 });
});

test('heartbeat는 멱등 키 없이 현재 번호를 확인하고 세션 시작·정상 종료를 영속 보고한다', async () => {
  const r = runner();
  await r.start();
  handle = (req, res) => {
    if (req.path.endsWith('heartbeat')) res.writeHead(204, { 'x-current-epoch': '0' }).end();
    else if (req.path.endsWith('commands')) json(res, { currentEpoch: 0, commands: [] });
    else if (req.path.endsWith('policy')) json(res, { heartbeatSeconds: 60 });
    else if (req.path.endsWith('messages')) json(res, { messages: [], nextCursor: null });
    else res.writeHead(204).end();
  };
  await r.poll();
  await r.heartbeat();
  await r.stop('manual');
  expect(requests.filter((req) => req.path.endsWith('sessions')).map((req) => req.body.event)).toEqual(['start', 'stop']);
  expect(requests.find((req) => req.path.endsWith('heartbeat'))?.headers).not.toHaveProperty('idempotency-key');
  const r2 = runner();
  handle = (_req, res) => res.writeHead(204, { 'x-current-epoch': '3' }).end();
  await r2.heartbeat();
  expect(state.snapshot).toMatchObject({ epoch: 0, pendingEpoch: 3 });
});

test('시작 직후 종료해도 명령 확인 전에 보고를 보내지 않고 세션을 디스크에 남긴다', async () => {
  const r = runner();
  await r.start();
  await r.stop('manual');
  expect(requests).toHaveLength(0);
  expect(state.snapshot.outbox.map((entry) => entry.request.body?.event)).toEqual(['start', 'stop']);
});

test('polling은 명령 우선·ETag 정책·동일 시각 메시지의 영속 커서를 지키고 실제 전달 때만 ack한다', async () => {
  handle = (req, res) => {
    if (req.path.endsWith('commands')) json(res, { currentEpoch: 0, commands: [] });
    else if (req.path.endsWith('policy')) {
      if (req.headers['if-none-match'] === '"v1"') res.writeHead(304).end();
      else { res.setHeader('etag', '"v1"'); json(res, { heartbeatSeconds: 30 }); }
    } else if (req.path.startsWith('/api/runner/messages')) json(res, { messages: req.path.includes('cursor=') ? [] : [1, 2].map((id) => ({ id: String(id), taskKey: 'TASK-0001', attemptId: null, toAgent: 'Codex', type: '추가 지시', body: '내용', pendingNext: true, createdAt: '2026-11-26T00:00:00Z' })), nextCursor: 'opaque/cursor' });
    else res.writeHead(204).end();
  };
  const r = runner();
  await Promise.all([r.poll(), r.poll()]);
  expect(requests[0]?.path).toBe('/api/runner/commands');
  expect(state.snapshot).toMatchObject({ cursor: 'opaque/cursor', inbox: [{ id: '1' }, { id: '2' }] });
  expect(requests.some((req) => req.path.endsWith('/ack'))).toBe(false);
  await r.ackMessage('1');
  await r.poll();
  expect(requests.filter((req) => req.path.endsWith('/ack'))).toHaveLength(1);
  expect(requests.filter((req) => req.path.endsWith('policy'))[1]?.headers['if-none-match']).toBe('"v1"');
  expect(requests.some((req) => req.path.includes('cursor=opaque%2Fcursor'))).toBe(true);
  expect((await reopen()).snapshot.inbox.map((m) => m.id)).toEqual(['2']);
  expect(r.heartbeatSeconds).toBe(30);
});
