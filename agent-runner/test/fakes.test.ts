import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { installFakeCli, runCli } from './fakes/cli.ts';
import { startFakeGitHub, type FakeGitHub } from './fakes/github/server.ts';

describe('fake CLI', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "awbs fake'"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  test.each([
    ['claude', 'result'],
    ['codex', 'turn.completed'],
  ] as const)('%s: 기본 시나리오를 JSONL로 출력하고 호출을 기록한다', async (agent, last) => {
    const cli = installFakeCli(dir, agent);
    const result = await runCli(cli.path, ['-p', "a 'b' $c"], { stdin: '지시' });
    expect(result.code).toBe(0);
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string });
    expect(events.at(-1)?.type).toBe(last);
    expect(cli.calls()).toMatchObject([{ argv: ['-p', "a 'b' $c"], stdin: '지시' }]);
  });

  test('실패·깨진 줄을 그대로 재현한다', async () => {
    const cli = installFakeCli(dir, 'codex', { lines: ['{깨진', { type: 'unknown' }], stderr: '오류', exitCode: 7 });
    expect(await runCli(cli.path, [])).toEqual({
      code: 7,
      signal: null,
      stdout: '{깨진\n{"type":"unknown"}\n',
      stderr: '오류',
    });
  });

  test('멈춘 세션과 SIGTERM 무시를 재현한다', async () => {
    const hanging = installFakeCli(dir, 'claude', { lines: ['ready'], hang: true });
    expect(await runCli(hanging.path, [], { onFirstOutput: (child) => child.kill('SIGTERM') })).toMatchObject({
      signal: 'SIGTERM',
    });
    const stubborn = installFakeCli(dir, 'claude', { lines: ['ready'], hang: true, ignoreSigterm: true });
    let aliveAfterTerm = false;
    const result = await runCli(stubborn.path, [], {
      onFirstOutput: (child) => {
        child.kill('SIGTERM');
        setTimeout(() => {
          aliveAfterTerm = child.exitCode === null && child.signalCode === null;
          child.kill('SIGKILL');
        }, 300);
      },
    });
    expect(aliveAfterTerm).toBe(true);
    expect(result.signal).toBe('SIGKILL');
  });

  test('환경 변수는 이름만 기록한다', async () => {
    const cli = installFakeCli(dir, 'claude');
    await runCli(cli.path, [], { env: { PATH: '/usr/bin:/bin', SAMPLE_TOKEN: 'hunter2' } });
    expect(cli.calls()[0]?.envNames).toContain('SAMPLE_TOKEN');
    expect(JSON.stringify(cli.calls())).not.toContain('hunter2');
  });
});

describe('fake GitHub', () => {
  let github: FakeGitHub;
  const get = (path: string, token = 'fake-token') =>
    fetch(`${github.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  beforeEach(async () => {
    github = await startFakeGitHub('fake-token');
  });
  afterEach(() => github.close());

  test('등록한 응답을 주고 요청을 기록한다', async () => {
    github.on('GET /repos/o/r', () => ({ body: { private: true }, headers: { etag: 'W/"1"' } }));
    const response = await get('/repos/o/r?page=2');
    expect(await response.json()).toEqual({ private: true });
    expect(response.headers.get('etag')).toBe('W/"1"');
    expect(github.requests).toEqual([{ method: 'GET', path: '/repos/o/r', query: { page: '2' }, body: undefined }]);
    github.assertNoUnexpected();
  });

  test('토큰이 다르면 401이고 처리하지 않는다', async () => {
    expect((await get('/repos/o/r', 'wrong')).status).toBe(401);
    expect(github.requests).toEqual([]);
  });

  test('경로 변수로 등록하면 값을 넘기고, 완전 일치가 먼저다', async () => {
    github.on('GET /repos/:owner/:repo', (request) => ({ body: request.params }));
    github.on('GET /repos/o/fixed', () => ({ body: 'exact' }));
    expect(await (await get('/repos/o/r%2Fx')).json()).toEqual({ owner: 'o', repo: 'r/x' });
    expect(await (await get('/repos/o/fixed')).json()).toBe('exact');
    expect((await get('/repos/o')).status).toBe(501);
  });

  test('drop이면 처리한 뒤 응답 없이 연결을 끊는다', async () => {
    let handled = false;
    github.on('PUT /x', () => {
      handled = true;
      return { drop: true };
    });
    await expect(
      fetch(`${github.url}/x`, { method: 'PUT', headers: { authorization: 'Bearer fake-token' } }),
    ).rejects.toThrow();
    expect(handled).toBe(true);
  });

  test('등록하지 않은 호출은 501이고 검사에서 실패한다', async () => {
    expect((await get('/user')).status).toBe(501);
    expect(() => {
      github.assertNoUnexpected();
    }).toThrow('GET /user');
  });
});
