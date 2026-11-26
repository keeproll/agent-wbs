import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const main = join(import.meta.dirname, '../src/main.ts');

test('설정이 없으면 종료 코드 2', () => {
  const result = spawnSync(process.execPath, [main], { env: {}, encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('AWBS_RUNNER_TOKEN');
});

test('SIGTERM으로 정상 종료하고 토큰을 남기지 않는다', async () => {
  const token = 'y'.repeat(43);
  const home = await mkdtemp('/home/keeproll/.orca/bots/agentwbs/archive/2026-11-26/M4-01/main-test-');
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
