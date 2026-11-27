import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CommandResult, RunCommand } from '../../src/readiness/command.ts';
import { blockedAgents, checkReadiness, scheduleDaily, type ReadinessDeps, type ReadinessKey } from '../../src/readiness/checks.ts';

const GiB = 1024 ** 3;
const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const missing: CommandResult = { code: null, stdout: '', stderr: 'spawn x ENOENT' };

/** 이 PC에서 2026-11-26에 확인한 무료 명령의 출력 형식 */
const HEALTHY: Record<string, CommandResult> = {
  'claude --version': ok('2.1.332 (Claude Code)\n'),
  'claude auth status --json': ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.com', orgName: 'Org' })),
  'codex --version': ok('codex-cli 0.172.0\n'),
  'codex login status': ok('Logged in using ChatGPT\n'),
  'git --version': ok('git version 2.43.0\n'),
  'node --version': ok('v26.13.0\n'),
  'pnpm --version': ok('12.16.1\n'),
  'gh --version': ok('gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)\nhttps://github.com/cli/cli/releases/tag/v2.45.0\n'),
  'git lfs version': ok('git-lfs/3.4.1 (GitHub; linux amd64; go 1.22.2)\n'),
  'pg_isready -h 127.0.0.1 -p 25442': ok('127.0.0.1:25442 - accepting connections\n'),
  'fc-list :family=Noto Sans KR family': ok('Noto Sans KR\n'),
};

const PROFILES = [
  { agent: 'Codex' as const, model: 'gpt-6.1-sol', options: 'exec --json' },
  { agent: 'Claude' as const, model: 'claude-opus-5-5', options: '-p --output-format stream-json' },
];
/** 서버에 등록된 관측 검증 조합(시험용 가정값) */
const VERIFIED = [
  { agent: 'Codex' as const, version: '0.172.0', model: 'gpt-6.1-sol', options: 'exec --json' },
  { agent: 'Claude' as const, version: '2.1.332', model: 'claude-opus-5-5', options: '-p --output-format stream-json' },
];

function deps(over: Record<string, CommandResult> = {}, extra: Partial<ReadinessDeps> = {}) {
  const calls: string[] = [];
  const table = { ...HEALTHY, ...over };
  const run: RunCommand = (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    return Promise.resolve(table[key] ?? missing);
  };
  const d: ReadinessDeps = {
    run,
    bins: { claude: 'claude', codex: 'codex', git: 'git', node: 'node', pnpm: 'pnpm', gh: 'gh', pgIsReady: 'pg_isready' },
    worktreeRoot: '/home/u/.agentwbs',
    diskFree: () => Promise.resolve(900 * GiB),
    readFile: (p) => (p === '/sys/fs/cgroup/cgroup.controllers' ? Promise.resolve('cpuset cpu io memory hugetlb pids rdma misc\n') : Promise.reject(new Error('ENOENT'))),
    pg: { host: '127.0.0.1', port: 25442 },
    cliProfiles: PROFILES,
    verifiedObservations: VERIFIED,
    probes: {
      repo: () => Promise.resolve({ status: 'ok', detail: '작업 저장소 접근 가능' }),
      subs: () => Promise.resolve({ status: 'ok', detail: '하위 Agent 정의 10개 동기화' }),
    },
    ...extra,
  };
  return { d, calls };
}

const AT = new Date('2026-11-26T09:00:00Z');
const item = async (key: string, over?: Record<string, CommandResult>, extra?: Partial<ReadinessDeps>) => {
  const report = await checkReadiness(deps(over, extra).d, AT);
  return report.items.find((i) => i.key === key);
};

describe('checkReadiness — POST /runner/readiness(G §7.4 「Runner 준비 상태」, contracts §3.1)', () => {
  test('모든 항목이 정상이면 13개 키가 모두 ok', async () => {
    const report = await checkReadiness(deps().d, AT);
    expect(report.at).toBe('2026-11-26T09:00:00.000Z');
    expect(report.items.map((i) => i.key)).toEqual(['claude', 'codex', 'git', 'node', 'pnpm', 'pg', 'repo', 'disk', 'subs', 'obs', 'gh', 'lfs', 'font']);
    expect(report.items.filter((i) => i.status !== 'ok')).toEqual([]);
  });

  test('무료 명령(버전·로그인 상태·도움말)만 부른다 — 모델 호출·갱신·네트워크 로그인 확인 없음', async () => {
    const { d, calls } = deps();
    await checkReadiness(d, AT);
    expect(calls.sort()).toEqual(Object.keys(HEALTHY).sort());
  });

  test('로그인 상태의 이메일·조직명을 보고에 싣지 않는다', async () => {
    const report = await checkReadiness(deps().d, AT);
    const text = JSON.stringify(report);
    expect(text).not.toContain('someone@example.com');
    expect(text).not.toContain('Org');
  });

  test('CLI 버전을 detail과 cli[]에 싣는다(관측 등급은 서버가 판정)', async () => {
    const report = await checkReadiness(
      deps({}, { cliProfiles: [{ agent: 'Codex', model: 'gpt-6.1-sol', options: 'exec --json' }, { agent: 'Claude', model: 'claude-opus-5-5', options: '-p --output-format stream-json' }] }).d,
      AT,
    );
    expect(report.items.find((i) => i.key === 'codex')?.detail).toContain('0.172.0');
    expect(report.cli).toEqual([
      { agent: 'Codex', version: '0.172.0', model: 'gpt-6.1-sol', options: 'exec --json' },
      { agent: 'Claude', version: '2.1.332', model: 'claude-opus-5-5', options: '-p --output-format stream-json' },
    ]);
  });

  test('cli 설정이 없으면 cli[]를 보내지 않고, 버전을 모르는 CLI는 빠진다', async () => {
    expect((await checkReadiness(deps({}, { cliProfiles: [] }).d, AT)).cli).toBeUndefined();
    const report = await checkReadiness(
      deps({ 'claude --version': missing }, { cliProfiles: [{ agent: 'Claude', model: 'm', options: 'o' }] }).d,
      AT,
    );
    expect(report.cli).toBeUndefined();
  });

  test('Codex 미설치 → fail + 설치 안내', async () => {
    expect(await item('codex', { 'codex --version': missing })).toMatchObject({ status: 'fail', fix: expect.stringContaining('설치') });
  });

  test('Codex 로그아웃 → fail + `codex login`', async () => {
    expect(await item('codex', { 'codex login status': { code: 1, stdout: 'Not logged in\n', stderr: '' } })).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('codex login'),
    });
  });

  test('Claude 로그아웃 → fail + `claude auth login`', async () => {
    expect(await item('claude', { 'claude auth status --json': ok('{"loggedIn":false}') })).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('claude auth login'),
    });
  });

  test('Claude 로그인 상태 출력을 읽지 못하면 추정하지 않고 warn', async () => {
    expect(await item('claude', { 'claude auth status --json': ok('알 수 없는 형식') })).toMatchObject({ status: 'warn' });
  });

  test('git·pnpm 미설치 → fail', async () => {
    expect((await item('git', { 'git --version': missing }))?.status).toBe('fail');
    expect((await item('pnpm', { 'pnpm --version': missing }))?.status).toBe('fail');
  });

  test('node가 Runner 요구 범위(>=26.13 <27) 밖이면 warn', async () => {
    expect((await item('node', { 'node --version': ok('v26.12.9\n') }))?.status).toBe('warn');
    expect((await item('node', { 'node --version': ok('v27.0.0\n') }))?.status).toBe('warn');
    expect((await item('node', { 'node --version': ok('v26.20.1\n') }))?.status).toBe('ok');
  });

  test('PostgreSQL: 연결 거부 → fail, 확인 도구 없음·주소 미설정 → warn', async () => {
    expect((await item('pg', { 'pg_isready -h 127.0.0.1 -p 25442': { code: 2, stdout: 'no response', stderr: '' } }))?.status).toBe('fail');
    expect((await item('pg', { 'pg_isready -h 127.0.0.1 -p 25442': missing }))?.status).toBe('warn');
    expect((await item('pg', {}, { pg: null }))?.status).toBe('warn');
  });

  test('디스크 여유: 50GB 미만 warn, 5GB 미만 fail', async () => {
    expect((await item('disk', {}, { diskFree: () => Promise.resolve(49.9 * GiB) }))?.status).toBe('warn');
    expect((await item('disk', {}, { diskFree: () => Promise.resolve(4.9 * GiB) }))?.status).toBe('fail');
    expect((await item('disk', {}, { diskFree: () => Promise.reject(new Error('ENOENT')) }))?.status).toBe('fail');
  });

  test('worktree가 Windows 드라이브(/mnt/c 등)에 있으면 warn(G §6.6 ext4 권장)', async () => {
    expect(await item('disk', {}, { worktreeRoot: '/mnt/c/work' })).toMatchObject({ status: 'warn', detail: expect.stringContaining('/mnt/') });
  });

  test('저장소·하위 Agent 점검을 아직 연결하지 않았으면 warn(확인 안 함을 정상으로 보이지 않는다)', async () => {
    const report = await checkReadiness(deps({}, { probes: {} }).d, AT);
    expect(report.items.find((i) => i.key === 'repo')?.status).toBe('warn');
    expect(report.items.find((i) => i.key === 'subs')?.status).toBe('warn');
  });

  test('점검기가 예외를 던지면 그 항목만 fail', async () => {
    const report = await checkReadiness(deps({}, { probes: { repo: () => Promise.reject(new Error('권한 없음')), subs: () => Promise.resolve({ status: 'ok', detail: 'x' }) } }).d, AT);
    expect(report.items.find((i) => i.key === 'repo')).toMatchObject({ status: 'fail', detail: expect.stringContaining('권한 없음') });
    expect(report.items.find((i) => i.key === 'subs')?.status).toBe('ok');
  });

  test('obs: 모든 CLI 조합이 관측 검증된 조합과 같으면 ok', async () => {
    expect((await item('obs'))?.status).toBe('ok');
  });

  test('obs: CLI 버전이 검증 버전과 다르면 warn — 미검증·보수 계산·재검증 대기, 실행은 계속(G §6.7-8, 리뷰 2)', async () => {
    const obs = await item('obs', { 'codex --version': ok('codex-cli 99.0.0\n') });
    expect(obs?.status).toBe('warn');
    expect(obs?.detail).toContain('Codex 99.0.0');
    expect(obs?.detail).toContain('미검증');
    expect(obs?.detail).toContain('보수 계산');
    expect(obs?.detail).toContain('재검증');
    // 최신 유지(Q-12): 구버전으로 내리라고 안내하지 않는다.
    expect(`${obs?.detail ?? ''} ${obs?.fix ?? ''}`).not.toMatch(/하향|내리|downgrade|0\.167/);
  });

  test('obs: 모델·옵션이 다른 조합도 미검증이다', async () => {
    const profiles = [{ agent: 'Codex' as const, model: 'gpt-9', options: 'exec --json' }];
    expect((await item('obs', {}, { cliProfiles: profiles }))?.status).toBe('warn');
  });

  test('obs: 검증 목록을 모르거나 실행 조합 설정이 없으면 확인할 수 없어 warn', async () => {
    expect((await item('obs', {}, { verifiedObservations: undefined }))?.status).toBe('warn');
    expect((await item('obs', {}, { cliProfiles: [] }))?.status).toBe('warn');
  });

  test('obs: 루트 cgroup에 controller가 있어도 CLI가 미검증이면 ok가 아니다(cgroup은 보조 정보)', async () => {
    const obs = await item('obs', { 'claude --version': ok('2.2.0 (Claude Code)\n') }, { readFile: () => Promise.resolve('cpu memory pids\n') });
    expect(obs?.status).toBe('warn');
  });

  test('obs: cgroup 정보는 detail에 보조로만 싣고 상태를 바꾸지 않는다', async () => {
    const lacking = await item('obs', {}, { readFile: () => Promise.reject(new Error('ENOENT')) });
    expect(lacking?.status).toBe('ok');
    expect(lacking?.detail).toMatch(/cgroup/);
    expect(lacking?.detail).toMatch(/M5-03/);
  });

  test('gh·git-lfs 미설치는 warn(토큰 방식·LFS 없는 저장소는 필요 없음)', async () => {
    expect((await item('gh', { 'gh --version': missing }))?.status).toBe('warn');
    expect(await item('lfs', { 'git lfs version': { code: 1, stdout: '', stderr: "git: 'lfs' is not a git command" } })).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('git-lfs'),
    });
  });
});

describe('font — 야간 화면 비교 고정 글꼴(M7-03 결정 12)', () => {
  test('설치돼 있으면 ok, 없으면 warn이고 실행을 멈추지 않는다', async () => {
    expect(await item('font')).toMatchObject({ status: 'ok' });
    const absent = await item('font', { 'fc-list :family=Noto Sans KR family': ok('') });
    expect(absent).toMatchObject({ status: 'warn', detail: expect.stringContaining('비교 불가'), fix: expect.stringContaining('Noto Sans KR') });
    const report = await checkReadiness(deps({ 'fc-list :family=Noto Sans KR family': missing }).d, AT);
    expect(report.items.find(i => i.key === 'font')?.status).toBe('warn');
    expect(blockedAgents(report.items)).toEqual([]);
  });
});

describe('blockedAgents — fail 항목은 해당 Agent 실행 중지(G §8.2)', () => {
  const it = (key: ReadinessKey, status: 'ok' | 'warn' | 'fail') => ({ key, status, detail: '' }) as const;
  test('claude fail은 Claude만, codex fail은 Codex만 멈춘다', () => {
    expect(blockedAgents([it('claude', 'fail'), it('codex', 'ok')])).toEqual(['Claude']);
    expect(blockedAgents([it('codex', 'fail')])).toEqual(['Codex']);
  });
  test('공통 항목 fail은 둘 다 멈춘다', () => {
    expect(blockedAgents([it('git', 'fail')])).toEqual(['Claude', 'Codex']);
  });
  test('warn은 멈추지 않는다', () => {
    expect(blockedAgents([it('claude', 'warn'), it('disk', 'warn')])).toEqual([]);
  });
});

describe('scheduleDaily — 시작 시 + 매일 한 번', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('바로 한 번, 이후 24시간마다. stop 뒤에는 멈춘다', async () => {
    vi.useFakeTimers();
    let n = 0;
    const s = scheduleDaily(() => {
      n += 1;
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(24 * 3600_000 - 1);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(n).toBe(2);
    s.stop();
    await vi.advanceTimersByTimeAsync(48 * 3600_000);
    expect(n).toBe(2);
  });

  test('실패해도 다음 날 다시 하고, 오류를 알린다', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    let n = 0;
    const s = scheduleDaily(
      () => {
        n += 1;
        return Promise.reject(new Error('boom'));
      },
      { onError: (e) => errors.push(e) },
    );
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(n).toBe(2);
    expect(errors).toHaveLength(2);
    s.stop();
  });

  test('앞 점검이 안 끝났으면 겹쳐 돌리지 않는다', async () => {
    vi.useFakeTimers();
    let running = 0;
    let maxRunning = 0;
    const s = scheduleDaily(
      async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 30 * 3600_000));
        running -= 1;
      },
    );
    await vi.advanceTimersByTimeAsync(60 * 3600_000);
    expect(maxRunning).toBe(1);
    s.stop();
  });
});
