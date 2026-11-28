import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Agent } from '../api/generated/client.ts';
import type { IsolationLayer, Launch } from '../cli/isolation.ts';
import type { RunCommand } from '../readiness/command.ts';

/*
 * 사용자 cgroup scope(M5-03 실측, M8 전 연결).
 *
 * scope = systemd가 프로세스 묶음 하나에 붙이는 이름표다. 그 묶음은 커널의 cgroup(control group, 프로세스 묶음) 하나가 된다.
 * Runner 계정의 사용자 systemd(`systemd-run --user`)가 만든 scope의 cgroup 파일은 Runner 계정 소유다.
 * - 그래서 Runner는 그 안의 프로세스가 어느 계정(sudo=root, Agent=awbs-agent)이든 `cgroup.kill` 한 번으로 모두 끝낼 수 있다.
 * - Agent 계정은 Runner 소유 cgroup 파일을 쓸 수 없어 scope 밖으로 나가지 못한다. `setsid`·이중 fork·환경 표식 지우기로도 못 나간다.
 * 왜 필요한가: Runner(keeproll)는 다른 계정 프로세스에 신호를 보낼 수 없고(EPERM) `/proc`에서 소속도 가리지 못한다.
 *   프로세스 그룹만 보면 그룹을 빠져나간 Agent 자손이 남아도 「비었다」고 증명하게 된다(isolation.md §9).
 *
 * 운영 요구사항: 사용자 systemd는 로그인 세션이나 linger(`loginctl enable-linger <계정>`)가 있어야 뜬다.
 * 없으면 `probeUserScope`가 실패하고 전용 계정 실행을 거부한다(fail-closed).
 */

export const SYSTEMD_RUN = '/usr/bin/systemd-run';
/** scope 이름 앞머리. 이 이름으로 Runner가 만든 scope만 다룬다. */
const PREFIX = 'awbs-';
const UNIT = /^awbs-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Runner 계정 번호. 시험은 같은 값을 쓴다. */
function uid(): number {
  const value = process.getuid?.();
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) throw new Error('Runner 계정 번호(UID)를 알 수 없습니다.');
  return value;
}

/** scope 이름이 Runner가 만든 모양인가. 기록에서 읽은 값도 이 검사를 지난 것만 쓴다. */
export function validScopeUnit(unit: unknown): unit is string {
  return typeof unit === 'string' && UNIT.test(unit);
}

export function newScopeUnit(): string {
  return `${PREFIX}${randomUUID()}`;
}

/**
 * scope의 cgroup 폴더. `--slice=app.slice`로 만들기 때문에 위치가 정해져 있다.
 * 예: `/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/awbs-<uuid>.scope`
 * 왜 systemctl로 묻지 않나: 묻는 명령이 실패하면 「모름」이 된다. 경로가 정해져 있으면 파일만 보면 된다.
 */
export function scopeCgroup(unit: string): string {
  if (!validScopeUnit(unit)) throw new Error('scope 이름이 Runner가 만든 모양이 아닙니다.');
  const id = String(uid());
  return `/sys/fs/cgroup/user.slice/user-${id}.slice/user@${id}.service/app.slice/${unit}.scope`;
}

/**
 * 서버에 보고하는 cgroup 경로(`/proc/<pid>/cgroup`의 `0::` 뒤 모양). `/sys/fs/cgroup`을 뺀 값이다.
 * 서버는 이 값이 기록된 보유를 cgroup_empty 증거로만 닫는다(조정자 결정 3).
 */
export function scopeCgroupPath(unit: string): string {
  return scopeCgroup(unit).slice('/sys/fs/cgroup'.length);
}

/** 사용자 systemd에 닿는 데 필요한 환경. sudo가 어차피 지우므로 Agent에게는 넘어가지 않는다. */
export function scopeEnv(): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: `/run/user/${String(uid())}` };
}

/**
 * 실행 계획을 사용자 scope로 감싼다: `systemd-run --user --scope --unit awbs-<uuid> -- <원래 명령>`.
 * - `--scope`: systemd-run이 자기 자신을 새 scope로 옮긴 뒤 원래 명령으로 바뀐다(exec). 프로세스 번호가 그대로라 launch 정체성(pgid·시작 시각)이 유지된다.
 * - `--collect`: 실패로 끝나도 scope 이름을 남기지 않는다.
 * - `--slice=app.slice`: cgroup 위치를 고정한다(`scopeCgroup`).
 */
export function inUserScope(launch: Launch, unit: string = newScopeUnit()): Launch {
  if (!validScopeUnit(unit)) throw new Error('scope 이름이 Runner가 만든 모양이 아닙니다.');
  return {
    file: SYSTEMD_RUN,
    args: ['--user', '--scope', '--quiet', '--collect', '--slice=app.slice', `--unit=${unit}`, '--', launch.file, ...launch.args],
    env: scopeEnv(),
    cwd: launch.cwd,
    stdin: launch.stdin,
    scope: unit,
  };
}

/**
 * 격리 계층을 사용자 scope로 한 번 더 감싼다. CLI 옵션(`flags`)은 안쪽 계층 그대로다.
 * 왜 옵션을 바꾸지 않나: scope는 CLI가 보는 실행 조건이 아니라 Runner의 정리 수단이다. 관측 등급 조합(`sessionOptions`)을 바꿀 이유가 없다.
 */
export function withUserScope(inner: IsolationLayer): IsolationLayer {
  return {
    name: `${inner.name}+user-scope`,
    flags: (agent: Agent) => inner.flags(agent),
    wrap: (launch: Launch, agent: Agent) => inUserScope(inner.wrap(launch, agent)),
    // ①·CI 명령도 같은 사용자 scope 안에서 돈다. 안쪽 계층에 command가 없으면 scope로 감쌀 대상도 없으므로 거부한다.
    command: (launch: Launch) => {
      if (!inner.command) throw new Error('이 격리 계층은 ①·CI 명령을 실행하지 않습니다.');
      return inUserScope(inner.command(launch));
    },
  };
}

/**
 * 이 PC에서 사용자 scope를 만들 수 있는지 실제로 한 번 만들어 본다(`/bin/true`, 돈 들지 않음).
 * 문제가 없으면 null, 있으면 readiness 경고에 쓸 이유 문장이다. 외부 명령 출력은 옮기지 않는다.
 * `env`로 사용자 systemd 주소(XDG_RUNTIME_DIR)를 붙인다. 점검 명령 실행기의 허용 환경에는 이 값이 없기 때문이다.
 */
export async function probeUserScope(run: RunCommand): Promise<string | null> {
  const env = Object.entries(scopeEnv()).map(([key, value]) => `${key}=${value ?? ''}`);
  const unit = newScopeUnit();
  // scope 안에서 cgroup 파일 시스템 종류와 자기 cgroup 경로를 읽는다(방어 점검 4, 조정자 결정 8).
  // 왜: 정리·증거는 계산한 경로(scopeCgroup)를 본다. 이 PC에서 실제 경로가 다르면(cgroup v1·혼합, 다른 slice) 「없음=비었음」이 거짓 증거가 된다.
  const result = await run('/usr/bin/env', ['-i', ...env, SYSTEMD_RUN, '--user', '--scope', '--quiet', '--collect', '--slice=app.slice', `--unit=${unit}`,
    '--', '/bin/sh', '-c', 'stat -f -c %T /sys/fs/cgroup; cat /proc/self/cgroup']);
  if (result.code !== 0) return '사용자 systemd scope를 만들 수 없습니다(linger·로그인 세션 확인: loginctl enable-linger).';
  if (result.stdout !== `cgroup2fs\n0::${scopeCgroupPath(unit)}\n`) return '사용자 scope의 cgroup 위치가 예상과 다릅니다(cgroup v2 단일 계층과 app.slice 필요).';
  return null;
}

/** 이 cgroup 경로(`0::<경로>`)에 든 프로세스가 /proc에 하나라도 있는가. 다른 계정 프로세스의 /proc/<pid>/cgroup도 읽힌다. */
async function hasMembers(unit: string): Promise<boolean> {
  const line = `0::${scopeCgroupPath(unit)}`;
  for (const name of await readdir('/proc')) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    try { if ((await readFile(`/proc/${name}/cgroup`, 'utf8')).split('\n').includes(line)) return true; }
    catch (e) { if (!['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
  }
  return false;
}

/**
 * scope 폴더가 없거나(ENOENT) 지금 지워지는 중(ENODEV)이다. systemd가 빈 scope를 지우는 순간 그 안의 파일을 열면 ENODEV가 난다
 * (실계정 attempt-wiring에서 짧은 ① 명령 뒤 재현). 어느 쪽이든 이것만으로 「비었다」로 보지 않고 /proc 대조로 확인한다(조정자 결정 8).
 */
const gone = (e: unknown) => ['ENOENT', 'ENODEV'].includes((e as NodeJS.ErrnoException).code ?? '');

/** scope 안에 살아 있는 프로세스가 없는가. scope가 이미 사라졌으면(systemd가 빈 scope를 지움) 비었다. 읽지 못하면 예외. */
export async function scopeEmpty(unit: string): Promise<boolean> {
  try {
    const events = await readFile(`${scopeCgroup(unit)}/cgroup.events`, 'utf8');
    const populated = /^populated ([01])$/m.exec(events)?.[1];
    if (populated === undefined) throw new Error('cgroup.events 형식이 다릅니다.');
    return populated === '0';
  } catch (e) {
    // scope 폴더가 없다고 바로 「비었다」로 보지 않는다(방어 점검 4). /proc에서 그 경로의 프로세스가 정말 없는지 대조한다.
    if (gone(e)) return !await hasMembers(unit);
    throw e;
  }
}

/**
 * scope 안의 프로세스를 계정과 상관없이 모두 끝내고, 비었는지 확인한다.
 * - `cgroup.kill`에 1을 쓰면 커널이 그 cgroup(과 하위 cgroup)의 모든 프로세스에 SIGKILL을 보낸다.
 * - 그 뒤 `cgroup.events`의 `populated 0` 또는 scope 폴더가 사라진 것을 확인한다.
 * 비었으면 true, 시간 안에 비지 않았으면 false(「모름」)다. 파일을 못 쓰는 다른 오류는 예외로 올린다.
 */
export async function clearScope(unit: string, timeoutMs = 2_000): Promise<boolean> {
  const path = scopeCgroup(unit);
  try {
    if (await scopeEmpty(unit)) return true;
    await writeFile(`${path}/cgroup.kill`, '1');
  } catch (e) {
    // 확인과 쓰기 사이에 비어서 systemd가 지웠다. 그래도 /proc에서 그 경로의 프로세스가 없는지 대조한다.
    if (gone(e)) return !await hasMembers(unit);
    throw e;
  }
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (await scopeEmpty(unit)) return true;
    if (performance.now() >= deadline) return false;
    await sleep(10);
  }
}
