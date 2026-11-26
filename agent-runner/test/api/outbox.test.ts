import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createApiClient } from '../../src/api/client.ts';
import { Outbox } from '../../src/api/outbox.ts';
import { Runner } from '../../src/api/runner.ts';
import { State } from '../../src/state/state.ts';
import { Secret } from '../../src/security/secret.ts';

const archive = '/home/keeproll/.orca/bots/agentwbs/archive/2026-11-26/M4-01';
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
  outbox = new Outbox(state, api(), { now: () => now, random: () => 0 });
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});

test('보고를 먼저 원자 저장하고 재시작해도 키·본문·Runner 식별자를 유지한다', async () => {
  const entry = await usage();
  expect(requests).toHaveLength(0);
  const restored = await State.open(home);
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

test('같은 시도의 뒤 보고는 보류하고 다른 시도의 보고는 보낸다', async () => {
  handle = (req, res) => req.path.includes('/a/') ? fail(res, 503) : res.writeHead(204).end();
  await status('a');
  await outbox.enqueue('reportAttemptResult', { epoch: 0, params: { attemptId: 'a' }, body: { fence: 1, summary: '완료', changedFiles: [], evidence: [] } });
  await status('b');
  await Promise.all([outbox.flush(), outbox.flush()]);
  expect(requests.map((req) => req.path)).toEqual(['/api/runner/attempts/a/status', '/api/runner/attempts/b/status']);
  expect(state.snapshot.outbox).toHaveLength(2);
});

test.each([400, 404, 409, 422])('%s는 rejected로 보존하고 같은 시도 뒤 보고를 막으며 준비 상태 경고를 남긴다', async (code) => {
  handle = (_req, res) => fail(res, code);
  await status('a');
  await outbox.enqueue('reportAttemptResult', { epoch: 0, params: { attemptId: 'a' }, body: { fence: 1, summary: '완료', changedFiles: [], evidence: [] } });
  await outbox.flush();
  now += 1_000_000;
  await outbox.flush();
  expect(requests).toHaveLength(1);
  expect(state.snapshot.outbox[0]).toMatchObject({ state: 'rejected', status: code });
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
  await new Outbox(await State.open(home), api()).flush();
  const req = requests[0];
  const form = await new Response(new Uint8Array(req?.raw ?? []), { headers: { 'content-type': req?.headers['content-type'] ?? '' } }).formData();
  expect(new Uint8Array(await (form.get('file') as File).arrayBuffer())).toEqual(bytes);
});

test('동시에 쌓은 보고를 잃지 않고 손상된 상태 파일은 덮어쓰지 않는다', async () => {
  await Promise.all(Array.from({ length: 20 }, () => usage()));
  expect((await State.open(home)).snapshot.outbox).toHaveLength(20);
  await writeFile(join(home, 'state/runner.json'), '{broken');
  await expect(State.open(home)).rejects.toThrow();
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
    expect((await State.open(home)).snapshot.outbox).toEqual([]);
  } finally { child.kill('SIGKILL'); }
});

const runner = (cleanup?: ConstructorParameters<typeof Runner>[0]['cleanup']) => new Runner({ state, api: api(), version: 'test', now: () => now, ...(cleanup && { cleanup }) });
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
    } else fail(res, 409, 'EPOCH_MISMATCH', { currentEpoch: 2 });
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

test('heartbeat는 멱등 키 없이 현재 번호를 확인하고 세션 시작·정상 종료를 영속 보고한다', async () => {
  const r = runner();
  await r.start();
  handle = (req, res) => req.path.endsWith('heartbeat') ? res.writeHead(204, { 'x-current-epoch': '0' }).end() : res.writeHead(204).end();
  await r.heartbeat();
  await r.stop('manual');
  expect(requests.filter((req) => req.path.endsWith('sessions')).map((req) => req.body.event)).toEqual(['start', 'stop']);
  expect(requests.find((req) => req.path.endsWith('heartbeat'))?.headers).not.toHaveProperty('idempotency-key');
  const r2 = runner();
  handle = (_req, res) => res.writeHead(204, { 'x-current-epoch': '3' }).end();
  await r2.heartbeat();
  expect(state.snapshot).toMatchObject({ epoch: 0, pendingEpoch: 3 });
});

test('polling은 명령 우선·ETag 정책·동일 시각 메시지의 영속 커서를 지키고 실제 전달 때만 ack한다', async () => {
  handle = (req, res) => {
    if (req.path.endsWith('commands')) json(res, { currentEpoch: 0, commands: [] });
    else if (req.path.endsWith('policy')) {
      if (req.headers['if-none-match'] === '"v1"') res.writeHead(304).end();
      else { res.setHeader('etag', '"v1"'); json(res, { heartbeatSeconds: 30 }); }
    } else if (req.path.startsWith('/api/runner/messages?')) json(res, { messages: req.path.includes('cursor=') ? [] : [1, 2].map((id) => ({ id: String(id), taskKey: 'TASK-0001', attemptId: null, toAgent: 'Codex', type: '추가 지시', body: '내용', pendingNext: true, createdAt: '2026-11-26T00:00:00Z' })), nextCursor: 'opaque/cursor' });
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
  expect((await State.open(home)).snapshot.inbox.map((m) => m.id)).toEqual(['2']);
  expect(r.heartbeatSeconds).toBe(30);
});
