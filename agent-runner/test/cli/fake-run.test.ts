import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { buildLaunch, type Launch } from '../../src/cli/args.ts';
import { parseStream } from '../../src/cli/adapters.ts';
import type { IsolationLayer } from '../../src/cli/isolation.ts';
import { SubagentObserver } from '../../src/cli/observe.ts';
import { JsonlDecoder } from '../../src/cli/stream.ts';
import { installFakeCli } from '../fakes/cli.ts';
import { fixturePath } from './helpers.ts';

const root = mkdtempSync(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'awbs-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const isolation: IsolationLayer = { name: 'fake', flags: () => [], wrap: (l) => l };
const hostEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, AWBS_RUNNER_TOKEN: 'runner-secret', GH_TOKEN: 'ghp_secret', SSH_AUTH_SOCK: '/tmp/s', CODEX_HOME: join(root, 'codex') };

/** 시험 전용 실행. 실제 세션 실행(프로세스 그룹·강제 종료)은 M5-02 exec가 맡는다. */
function exec(l: Launch): Promise<{ code: number | null; records: ReturnType<JsonlDecoder['end']> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(l.file, l.args, { cwd: l.cwd, env: l.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const d = new JsonlDecoder();
    const records: ReturnType<JsonlDecoder['end']> = [];
    child.stdout.on('data', (c: Buffer) => records.push(...d.push(c)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, records: [...records, ...d.end()] }));
    child.stdin.end(l.stdin);
  });
}

const lines = (agent: 'Codex' | 'Claude', name: string) => readFileSync(fixturePath(agent, name), 'utf8').split('\n').filter(Boolean);

describe('fake CLI로 어댑터 전체 경로(실제 Claude·Codex 호출 없음)', () => {
  test.each([['Codex', 'gpt-6.2-sol', 'subagents', 1], ['Claude', 'claude-opus-5-5', 'background', 0]] as const)(
    '%s: argv·stdin·env allowlist가 CLI에 그대로 닿고, 출력이 이벤트로 해석된다', async (agent, model, name, observed) => {
      const fake = installFakeCli(join(root, agent), agent === 'Codex' ? 'codex' : 'claude', { lines: lines(agent, name) });
      const l = buildLaunch(agent, fake.path, { model, effort: 'high', cwd: root, prompt: 'TASK-0001 지시문' }, { env: hostEnv, isolation });
      const { code, records } = await exec(l);
      expect(code).toBe(0);
      const [call] = fake.calls();
      expect(call?.argv).toEqual(l.args);
      expect(call?.stdin).toBe('TASK-0001 지시문');
      expect(call?.cwd).toBe(root);
      for (const secret of ['AWBS_RUNNER_TOKEN', 'GH_TOKEN', 'SSH_AUTH_SOCK']) expect(call?.envNames).not.toContain(secret);
      expect(call?.envNames).toContain('DISABLE_AUTOUPDATER');
      const o = new SubagentObserver();
      for (const e of parseStream(agent, records)) o.apply(e);
      o.finish();
      expect(o.snapshot()).toMatchObject({ observed, state: 'ok', ended: true });
    });

  test('CLI가 오류 코드로 끝나고 결과 이벤트가 없으면 미확인', async () => {
    const fake = installFakeCli(join(root, 'exit'), 'codex', { lines: lines('Codex', 'success').slice(0, 4), exitCode: 2 });
    const l = buildLaunch('Codex', fake.path, { model: 'gpt-6.2-sol', effort: 'low', cwd: root, prompt: 'x' }, { env: hostEnv, isolation });
    const { code, records } = await exec(l);
    expect(code).toBe(2);
    const o = new SubagentObserver();
    for (const e of parseStream('Codex', records)) o.apply(e);
    o.finish();
    expect(o.snapshot().state).toBe('unconfirmed');
  });
});
