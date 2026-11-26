import { mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CliUpdater, type Activity, type CliRegistry, type UpdateDeps } from '../../src/cli-update/manager.ts';
import type { Agent } from '../../src/api/generated/client.ts';
import type { ReadinessReport } from '../../src/readiness/checks.ts';

const archive = join(homedir(), '.orca/bots/agentwbs/archive/2026-11-26/M4-05');
const homes: string[] = [];
const owner = { hostId: 'pc-now', bootId: 'boot-now', runnerId: 'runner-now' };
const profile = { agent: 'Codex' as const, model: 'gpt-6.1-sol', options: 'exec --json' };
afterEach(async () => { vi.useRealTimers(); await Promise.all(homes.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

async function fixture(extra: Partial<UpdateDeps> = {}) {
  await mkdir(archive, { recursive: true });
  const home = await mkdtemp(join(archive, 'cli-test-'));
  homes.push(home);
  const reports: ReadinessReport[] = [];
  const activity: Activity[] = [];
  const latest: Record<Agent, string> = { Codex: '0.173.0', Claude: '2.1.333' };
  const failures = new Set<string>();
  const installed: string[] = [];
  const registry: CliRegistry = {
    latest: async (agent) => {
      if (failures.has(`${agent}:download`)) throw new Error('다운로드 실패');
      return latest[agent];
    },
    install: async (agent, version, directory) => {
      installed.push(`${agent}:${version}`);
      await mkdir(join(directory, 'bin'), { recursive: true });
      await writeFile(join(directory, 'bin', agent.toLowerCase()), version);
      if (failures.has(`${agent}:install`)) throw new Error('설치 실패');
    },
    probe: async (agent, version, bin) => {
      if (failures.has(`${agent}:probe`) && version === latest[agent]) throw new Error('무과금 점검 실패');
      if ((await readFile(bin, 'utf8')) !== version) throw new Error('버전 불일치');
    },
  };
  for (const [agent, version] of [['codex', '0.172.0'], ['claude', '2.1.332']] as const) {
    const base = join(home, 'cli', agent);
    await mkdir(join(base, version, 'bin'), { recursive: true });
    await writeFile(join(base, version, 'bin', agent), version);
    await symlink(version, join(base, 'current'));
  }
  const deps: UpdateDeps = {
    home, owner, registry, activity: async () => activity,
    profiles: () => [profile], verified: () => [{ ...profile, version: '0.172.0' }],
    report: async (r) => { reports.push(r); }, ...extra,
  };
  const updater = new CliUpdater(deps);
  return { home, updater, deps, latest, failures, reports, activity, installed,
    current: (agent = 'codex') => readlink(join(home, 'cli', agent, 'current')),
    pending: async (agent = 'codex') => JSON.parse(await readFile(join(home, 'cli', agent, 'update.json'), 'utf8')) as { update_pending: string | null },
  };
}

describe('cli-update — 유휴 적용·원본 보존(architecture §5.1)', () => {
  test('최신 확인은 대기만 저장하고, 유휴 적용 뒤 링크·보고의 버전이 함께 바뀐다', async () => {
    const f = await fixture();
    await f.updater.check();
    expect(await f.current()).toBe('0.172.0');
    expect(await f.pending()).toEqual({ update_pending: '0.173.0' });
    expect(f.installed).toEqual([]);
    await f.updater.applyPending();
    expect(await f.current()).toBe('0.173.0');
    expect(await f.current('claude')).toBe('2.1.333');
    expect(await f.pending()).toEqual({ update_pending: null });
    const report = f.reports.at(-1);
    expect(report?.cli).toEqual([{ ...profile, version: '0.173.0' }]);
    expect(report?.items.find((i) => i.key === 'obs')).toMatchObject({ status: 'warn', detail: expect.stringContaining('미검증') });
    expect(report?.items.find((i) => i.key === 'obs')?.detail).toContain('1+예산');
    expect(await readFile(join(f.home, 'cli/codex/0.172.0/bin/codex'), 'utf8')).toBe('0.172.0');
  });

  test.each([{ children: 1, held: 0 }, { children: 0, held: 1 }])('현재 소유자의 실행/보유 $children/$held가 있으면 새 설치 없이 보류', async (counts) => {
    const f = await fixture();
    f.activity.push({ ...owner, ...counts });
    await f.updater.check();
    await f.updater.applyPending();
    expect(await f.current()).toBe('0.172.0');
    expect(f.installed).toEqual([]);
    expect(f.reports.at(-1)?.items.find((i) => i.key === 'codex')).toMatchObject({ status: 'warn', detail: expect.stringContaining('0.173.0') });
    f.activity.length = 0;
    await f.updater.applyPending();
    expect(await f.current()).toBe('0.173.0');
  });

  test.each(['hostId', 'bootId', 'runnerId'] as const)('과거 %s의 미확인 보유는 지우지 않고 현재 유휴면 적용', async (key) => {
    const f = await fixture();
    f.activity.push({ ...owner, [key]: 'past', children: 3, held: 4 });
    await f.updater.check();
    await f.updater.applyPending();
    expect(await f.current()).toBe('0.173.0');
    expect(f.activity[0]?.held).toBe(4);
  });

  test('유휴 확인 뒤 claim이 끼어들면 잠금 안에서 다시 확인하여 설치하지 않는다', async () => {
    const f = await fixture();
    let reads = 0;
    f.deps.activity = async () => {
      reads += 1;
      return reads === 1 ? [] : [{ ...owner, children: 0, held: 1 }];
    };
    await f.updater.check();
    await f.updater.applyPending();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(f.installed).toEqual([]);
    expect(await f.current()).toBe('0.172.0');
  });

  test('claim 등록 중에는 적용을 보류하고, 업데이트 중에는 새 claim을 거절한다', async () => {
    const f = await fixture();
    await f.updater.check();
    const release = f.updater.tryClaim();
    expect(release).not.toBeNull();
    await f.updater.applyPending();
    expect(f.installed).toEqual([]);
    release?.();
    release?.();
    const install = f.deps.registry.install;
    const claims: unknown[] = [];
    f.deps.registry.install = async (...args) => {
      claims.push(f.updater.tryClaim());
      await install(...args);
    };
    await f.updater.applyPending();
    expect(claims).toEqual([null, null]);
    expect(await f.current()).toBe('0.173.0');
    expect(f.updater.tryClaim()).toBeTypeOf('function');
  });

  test.each(['download', 'install', 'probe'])('%s 실패는 이전 링크를 보존하고 다른 CLI는 적용하며 재시도한다', async (failure) => {
    const f = await fixture();
    f.failures.add(`Codex:${failure}`);
    await f.updater.check();
    await f.updater.applyPending();
    expect(await f.current()).toBe('0.172.0');
    expect(await f.current('claude')).toBe('2.1.333');
    expect(f.reports.at(-1)?.items.find((i) => i.key === 'codex')?.status).toBe('warn');
    f.failures.clear();
    await f.updater.check();
    await f.updater.applyPending();
    expect(await f.current()).toBe('0.173.0');
  });

  test('현재 CLI마저 실행 불능이면 해당 Agent만 fail', async () => {
    const f = await fixture();
    f.failures.add('Codex:install');
    await rm(join(f.home, 'cli/codex/0.172.0/bin/codex'));
    await f.updater.check();
    await f.updater.applyPending();
    expect(f.reports.at(-1)?.items.find((i) => i.key === 'codex')?.status).toBe('fail');
    expect(f.reports.at(-1)?.items.find((i) => i.key === 'claude')?.status).toBe('ok');
  });

  test('등록된 새 버전·모델·옵션 조합만 관측 검증 상태를 유지한다', async () => {
    const f = await fixture({ verified: () => [{ ...profile, version: '0.173.0' }] });
    await f.updater.check();
    await f.updater.applyPending();
    expect(f.reports.at(-1)?.items.find((i) => i.key === 'obs')?.status).toBe('ok');
    f.deps.profiles = () => [{ ...profile, options: 'exec --json --other' }];
    await f.updater.applyPending();
    expect(f.reports.at(-1)?.items.find((i) => i.key === 'obs')?.status).toBe('warn');
  });

  test.each(['0.171.9', '0.172.0'])('최신 채널 %s가 현재 이하이면 하향·재설치하지 않는다', async (version) => {
    const f = await fixture();
    f.latest.Codex = version;
    await f.updater.check();
    await f.updater.applyPending();
    expect(await f.current()).toBe('0.172.0');
    expect(f.installed.some((s) => s.startsWith('Codex:'))).toBe(false);
    expect(await f.pending()).toEqual({ update_pending: null });
  });

  test.each(['../outside', '1.2.3-beta', 'bad', '1.2.3/../x'])('채널의 잘못된 버전 %s를 경로로 쓰지 않는다', async (version) => {
    const f = await fixture();
    f.latest.Codex = version;
    await f.updater.check();
    await f.updater.applyPending();
    expect(await f.current()).toBe('0.172.0');
    expect(f.installed.some((s) => s.startsWith('Codex:'))).toBe(false);
    expect(f.reports.at(-1)?.items.find((i) => i.key === 'codex')?.status).toBe('warn');
  });

  test('재시작은 중단된 설치만 지우고 current와 이전 버전·전역 설치는 보존한다', async () => {
    const f = await fixture();
    const base = join(f.home, 'cli/codex');
    await mkdir(join(base, '.install-interrupted'));
    await writeFile(join(base, '.install-interrupted/partial'), 'partial');
    await symlink('0.173.0', join(base, '.current-interrupted'));
    await mkdir(join(f.home, 'global'));
    await writeFile(join(f.home, 'global/codex'), '사용자 전역 설치');
    await f.updater.recover();
    expect(await readdir(base)).toEqual(expect.arrayContaining(['0.172.0', 'current']));
    expect((await readdir(base)).some((s) => s.startsWith('.install-') || s.startsWith('.current-'))).toBe(false);
    expect(await f.current()).toBe('0.172.0');
    expect(await readFile(join(f.home, 'global/codex'), 'utf8')).toBe('사용자 전역 설치');
  });

  test('보고 실패 뒤에도 새 링크를 되돌리지 않고 잠금을 풀어 다음 보고를 재시도한다', async () => {
    const f = await fixture();
    await f.updater.check();
    f.deps.report = async () => { throw new Error('서버 연결 단절'); };
    await expect(f.updater.applyPending()).rejects.toThrow('서버 연결 단절');
    expect(await f.current()).toBe('0.173.0');
    const release = f.updater.tryClaim();
    expect(release).toBeTypeOf('function');
    release?.();
    f.deps.report = async (r) => { f.reports.push(r); };
    await f.updater.applyPending();
    expect(f.reports.at(-1)?.cli?.[0]?.version).toBe('0.173.0');
  });

  test.each(['before', 'after'])('current 원자 교체 %s에 프로세스를 강제 종료해도 재시작하면 완전한 버전을 쓴다', async (phase) => {
    const f = await fixture();
    const helper = fileURLToPath(new URL('../helpers/cli-update-crash.ts', import.meta.url));
    const result = await new Promise<{ code: number | null; signal: string | null; error: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [helper, f.home, phase], { stdio: ['ignore', 'ignore', 'pipe'] });
      let error = '';
      child.stderr.on('data', (part: Buffer) => { error += part.toString(); });
      child.on('error', reject);
      child.on('close', (code, signal) => { resolve({ code, signal, error }); });
    });
    expect(result).toEqual({ code: null, signal: 'SIGKILL', error: '' });
    expect(await f.current()).toBe(phase === 'before' ? '0.172.0' : '0.173.0');
    const restarted = new CliUpdater(f.deps);
    await restarted.recover();
    await restarted.check();
    await restarted.applyPending();
    expect(await f.current()).toBe('0.173.0');
    expect(await f.pending()).toEqual({ update_pending: null });
    expect(f.installed.some((i) => i.startsWith('Codex:'))).toBe(false);
    expect((await readdir(join(f.home, 'cli/codex'))).some((s) => s.startsWith('.current-'))).toBe(false);
    expect(await readFile(join(f.home, 'cli/codex/0.172.0/bin/codex'), 'utf8')).toBe('0.172.0');
  });

  test('처음 설치와 숫자 자릿수가 늘어나는 버전도 적용한다', async () => {
    const f = await fixture();
    await rm(join(f.home, 'cli/codex/current'));
    await f.updater.check();
    await f.updater.applyPending();
    expect(await f.current()).toBe('0.173.0');
    f.latest.Codex = '0.1000.0';
    await f.updater.check();
    await f.updater.applyPending();
    expect(await f.current()).toBe('0.1000.0');
  });

  test('시작과 매일 최신 확인을 예약하고 stop 뒤에는 설치하지 않는다', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const schedule = await f.updater.start((e) => { errors.push(e); });
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => { expect(vi.getTimerCount()).toBe(1); });
    expect(await f.current()).toBe('0.173.0');
    f.latest.Codex = '0.174.0';
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    await vi.waitFor(() => { expect(vi.getTimerCount()).toBe(1); });
    expect(await f.current()).toBe('0.174.0');
    schedule.stop();
    f.latest.Codex = '0.175.0';
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    await f.updater.applyPending();
    expect(await f.current()).toBe('0.174.0');
    expect(errors).toEqual([]);
  });

  test('변조된 대기 버전은 설치하지 않고 정상인 현재 CLI를 warn으로 유지한다', async () => {
    const f = await fixture();
    await writeFile(join(f.home, 'cli/codex/update.json'), '{"update_pending":"../../outside"}');
    await f.updater.applyPending();
    expect(await f.current()).toBe('0.172.0');
    expect(f.installed).toEqual([]);
    expect(f.reports.at(-1)?.items.find((i) => i.key === 'codex')?.status).toBe('warn');
  });

  test('설치 루트가 전역 폴더를 가리키면 정리·대기 파일을 그곳에 쓰지 않는다', async () => {
    const f = await fixture();
    const outside = join(f.home, 'global');
    await mkdir(outside);
    await mkdir(join(outside, '.install-user'));
    await writeFile(join(outside, '.install-user/codex'), '사용자 파일');
    await rm(join(f.home, 'cli/codex'), { recursive: true });
    await symlink(outside, join(f.home, 'cli/codex'));
    await expect(f.updater.recover()).rejects.toThrow();
    await f.updater.check();
    expect(await readFile(join(outside, '.install-user/codex'), 'utf8')).toBe('사용자 파일');
    expect(await readdir(outside)).toEqual(['.install-user']);
  });
});
