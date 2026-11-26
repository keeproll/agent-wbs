import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, expect, test } from 'vitest';
import { State } from '../src/state/state.ts';

const main = join(import.meta.dirname, '../src/main.ts');
beforeAll(async () => { await mkdir(process.env.AWBS_TEST_TMP ?? tmpdir(), { recursive: true }); });

test('설정이 없으면 종료 코드 2', () => {
  const result = spawnSync(process.execPath, [main], { env: {}, encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('AWBS_RUNNER_TOKEN');
});

test('SIGTERM으로 정상 종료하고 토큰을 남기지 않는다', async () => {
  const token = 'y'.repeat(43);
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'main-test-'));
  const events: string[] = [];
  let started: (() => void) | undefined;
  const sessionStarted = new Promise<void>((resolve) => { started = resolve; });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.url === '/api/runner/sessions') {
      events.push((JSON.parse(Buffer.concat(chunks).toString()) as { event: string }).event);
      if (events.includes('start')) started?.();
      res.writeHead(204).end();
    } else if (req.url === '/api/runner/heartbeat') res.writeHead(204, { 'x-current-epoch': '0' }).end();
    else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/runner/commands' ? { currentEpoch: 0, commands: [] }
        : req.url === '/api/runner/policy' ? { heartbeatSeconds: 60 } : { messages: [], nextCursor: null }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [main], { env: {
    AWBS_RUNNER_TOKEN: token, AWBS_HOME: home, AWBS_URL: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
  } });
  let output = '';
  child.stdout.on('data', (chunk) => (output += String(chunk)));
  child.stderr.on('data', (chunk) => (output += String(chunk)));
  try {
    await once(child.stdout, 'data');
    await sessionStarted;
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const [code] = await closed;
    expect(code).toBe(0);
    expect(output).toContain('SIGTERM');
    expect(output).not.toContain(token);
    expect(events).toEqual(['start', 'stop']);
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test('상태 파일 손상과 중복 실행은 비밀값 없이 다른 오류 종류로 기록한다', async () => {
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'main-error-'));
  const token = 'secret-token-'.repeat(4);
  let state: State | undefined;
  const launch = async () => {
    const child = spawn(process.execPath, [main], { env: { ...process.env, AWBS_RUNNER_TOKEN: token, AWBS_HOME: home } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    try { expect((await once(child, 'close'))[0]).toBe(1); return output; }
    finally { child.kill('SIGKILL'); }
  };
  try {
    await mkdir(join(home, 'state'));
    await writeFile(join(home, 'state/runner.json'), '{broken');
    const corrupt = await launch();
    expect(corrupt).toContain('STATE_CORRUPT');
    expect(corrupt).not.toContain(token);
    await rm(join(home, 'state/runner.json'));
    state = await State.open(home);
    const locked = await launch();
    expect(locked).toContain('STATE_LOCKED');
    expect(locked).not.toContain(token);
  } finally { await state?.close(); await rm(home, { recursive: true, force: true }); }
});
