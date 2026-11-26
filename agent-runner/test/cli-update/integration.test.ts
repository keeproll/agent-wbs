import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { expect, test } from 'vitest';
import { CliUpdater } from '../../src/cli-update/manager.ts';
import { createCliRegistry } from '../../src/cli-update/registry.ts';
import type { ReadinessReport } from '../../src/readiness/checks.ts';

test('가짜 npm·CLI를 실제 자식 프로세스로 실행해 전용 설치·로그인·옵션·환경·보고를 연결한다', async () => {
  const archive = join(homedir(), '.orca/bots/agentwbs/archive/2026-11-26/M4-05');
  await mkdir(archive, { recursive: true });
  const home = await mkdtemp(join(archive, 'process-test-'));
  try {
    const bin = join(home, 'fake-bin');
    await mkdir(bin);
    const global = join(bin, 'codex');
    await writeFile(global, '사용자 전역 설치 — 변경하면 안 됨');
    // 가짜 CLI도 실행 인자와 환경이 틀리면 실패한다. 유료 명령은 구현하지 않는다.
    const cli = `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
const agent = basename(process.argv[1]);
let args = process.argv.slice(2);
if (process.env.DISABLE_AUTOUPDATER !== '1' || process.env.DISABLE_UPDATES !== '1' || process.env.AWBS_RUNNER_TOKEN || process.env.GITHUB_TOKEN) process.exit(71);
if (agent === 'codex') {
  if (args[0] !== '-c' || args[1] !== 'check_for_update_on_startup=false') process.exit(72);
  args = args.slice(2);
}
appendFileSync(join(process.env.HOME, 'cli-calls.jsonl'), JSON.stringify({ agent, args }) + '\\n');
if (args.join(' ') === '--version') console.log(readFileSync(join(dirname(process.argv[1]), 'version'), 'utf8'));
else if (agent === 'codex' && args.join(' ') === 'login status') console.log('Logged in using ChatGPT');
else if (agent === 'claude' && args.join(' ') === 'auth status --json') console.log('{"loggedIn":true}');
else if (agent === 'codex' && args.join(' ') === 'exec --help') console.log('--json --model --sandbox');
else if (agent === 'claude' && args.join(' ') === '--help') console.log('--print --output-format stream-json --verbose');
else process.exit(73);
`;
    const npm = `#!${process.execPath}
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (process.env.AWBS_RUNNER_TOKEN || process.env.GITHUB_TOKEN) process.exit(74);
appendFileSync(join(process.env.HOME, 'npm-calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'view') console.log(JSON.stringify(args[1].startsWith('@openai/') ? '0.173.0' : '2.1.333'));
else if (args[0] === 'install') {
  const i = args.indexOf('--prefix');
  if (i < 0 || !args[i + 1].startsWith(join(process.env.HOME, 'cli'))) process.exit(75);
  const spec = args.find((s) => s.startsWith('@'));
  const agent = spec.startsWith('@openai/') ? 'codex' : 'claude';
  const directory = join(args[i + 1], 'bin');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, agent), ${JSON.stringify(cli)}, { mode: 0o700 });
  writeFileSync(join(directory, 'version'), spec.slice(spec.lastIndexOf('@') + 1));
} else process.exit(76);
`;
    await writeFile(join(bin, 'npm'), npm);
    await chmod(join(bin, 'npm'), 0o700);
    const registry = createCliRegistry({ home, env: { HOME: home, PATH: bin, AWBS_RUNNER_TOKEN: 'fake-secret', GITHUB_TOKEN: 'fake-secret' } });
    const reports: ReadinessReport[] = [];
    const updater = new CliUpdater({
      home, registry, owner: { hostId: 'host', bootId: 'boot', runnerId: 'runner' },
      activity: async () => [], verified: () => [], profiles: () => [{ agent: 'Codex', model: 'model', options: 'exec --json' }],
      report: async (r) => { reports.push(r); },
    });
    await updater.recover();
    await updater.check();
    await updater.applyPending();
    expect(await readlink(join(home, 'cli/codex/current'))).toBe('0.173.0');
    expect(await readlink(join(home, 'cli/claude/current'))).toBe('2.1.333');
    expect(await readFile(global, 'utf8')).toBe('사용자 전역 설치 — 변경하면 안 됨');
    expect(reports.at(-1)?.items.map(({ key, status }) => ({ key, status }))).toEqual([
      { key: 'codex', status: 'ok' }, { key: 'claude', status: 'ok' }, { key: 'obs', status: 'warn' },
    ]);
    expect(reports.at(-1)?.cli?.[0]?.version).toBe('0.173.0');
    const calls = (await readFile(join(home, 'npm-calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(calls.filter((args) => args[0] === 'install')).toHaveLength(2);
    const cliCalls = (await readFile(join(home, 'cli-calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { args: string[] });
    expect(cliCalls.every(({ args }) => ['--version', 'login status', 'auth status --json', 'exec --help', '--help'].includes(args.join(' ')))).toBe(true);
  } finally { await rm(home, { recursive: true, force: true }); }
});
