import type { Agent } from '../api/generated/client.ts';
import type { ApiRequest } from '../api/client.ts';
import type { CommandResult, RunCommand } from './command.ts';
import { checkBaselineFont } from '../ci/night/baseline.ts';

/** POST /runner/readiness 본문 */
export type ReadinessReport = ApiRequest<'reportReadiness'>['body'];
export type ReadinessItem = ReadinessReport['items'][number];
export type ReadinessKey = ReadinessItem['key'];
type Check = Omit<ReadinessItem, 'key'>;

/**
 * Runner 준비 점검(G §7.4, architecture §5 `readiness`). 시작할 때와 매일 한 번 돈다.
 * 실제 CLI에는 **무료 명령**(버전·로그인 상태·도움말)만 부른다 — 모델 호출, 모델 목록 갱신, GitHub 네트워크 확인은 하지 않는다.
 * 관측 등급(검증됨/일부 관측/미검증)은 CLI×버전×모델×옵션으로 서버가 판정하므로 Runner는 `cli[]`만 보낸다.
 */
export interface ReadinessDeps {
  run: RunCommand;
  bins: { claude: string; codex: string; git: string; node: string; pnpm: string; gh: string; pgIsReady: string };
  /** worktree를 만드는 위치(디스크 여유를 잴 곳) */
  worktreeRoot: string;
  diskFree(path: string): Promise<number>;
  readFile(path: string): Promise<string>;
  /** 점검할 PostgreSQL 주소. 설정이 없으면 null. */
  pg: { host: string; port: number } | null;
  /** 다른 모듈이 맡는 점검: 작업 저장소 접근(M4-03), 하위 Agent 정의 동기화(M5-02). 없으면 「확인 안 함」 warn. */
  probes: Partial<Record<'repo' | 'subs', () => Promise<Check>>>;
  /** 세션을 실행할 때 쓸 모델·옵션. 관측 등급 판정용 `cli[]`에 버전과 함께 싣는다. */
  cliProfiles?: { agent: Agent; model: string; options: string }[];
  /**
   * 관측이 검증된 CLI 조합(CLI·버전·모델·옵션) 목록. G §6.7-8 「CLI 버전 = 관측 검증된 버전인가」를 이것과 대조한다.
   * 서버 정책 `GET /runner/policy`의 `cliGrades` 중 `grade==='verified'`로 채운다(`verifiedFromPolicy`, contracts §3.1).
   * 정책을 아직 받지 못했으면 undefined → 확인 불가로 warn.
   */
  verifiedObservations?: { agent: Agent; version: string; model: string; options: string }[] | undefined;
}

// reports는 로컬 도구 점검이 아니라 RunnerApp이 거부 기록으로 채운다.
type EnvironmentKey = Exclude<ReadinessKey, 'reports'>;
const KEYS: EnvironmentKey[] = ['claude', 'codex', 'git', 'node', 'pnpm', 'pg', 'repo', 'disk', 'subs', 'obs', 'gh', 'lfs', 'font'];
/** P `recCap`의 DISK_LOW 기준 */
const DISK_WARN_GB = 50;
/** 이보다 적으면 clone·설치가 실패할 가능성이 커서 멈춘다 [결정] */
const DISK_FAIL_GB = 5;
/** package.json engines와 같다 */
const NODE_RANGE = { min: [26, 13, 0], belowMajor: 27 } as const;

const firstVersion = (text: string): string | null => /(\d+\.\d+\.\d+[\w.+-]*)/.exec(text)?.[1] ?? null;
const reason = (r: CommandResult): string => (r.stderr.trim() || r.stdout.trim() || `종료 코드 ${String(r.code)}`).slice(0, 200);
const runs = (r: CommandResult): boolean => r.code === 0;

async function cliVersion(d: ReadinessDeps, bin: string, name: string, install: string): Promise<{ version: string } | Check> {
  const r = await d.run(bin, ['--version']);
  const version = runs(r) ? firstVersion(r.stdout) : null;
  if (!version) return { status: 'fail', detail: `${name} 실행 불가: ${reason(r)}`, fix: install };
  return { version };
}

async function claude(d: ReadinessDeps, versions: Map<Agent, string>): Promise<Check> {
  const v = await cliVersion(d, d.bins.claude, 'Claude Code CLI', 'Claude Code CLI를 설치하세요(`claude install`).');
  if (!('version' in v)) return v;
  versions.set('Claude', v.version);
  const r = await d.run(d.bins.claude, ['auth', 'status', '--json']);
  let loggedIn: unknown;
  try {
    loggedIn = (JSON.parse(r.stdout) as { loggedIn?: unknown }).loggedIn;
  } catch {
    loggedIn = undefined;
  }
  // 이메일·조직 등 계정 정보는 싣지 않는다.
  if (loggedIn === true) return { status: 'ok', detail: `버전 ${v.version} · 로그인됨` };
  if (loggedIn === false) return { status: 'fail', detail: `버전 ${v.version} · 로그인 안 됨`, fix: '`claude auth login`을 실행하세요.' };
  return { status: 'warn', detail: `버전 ${v.version} · 로그인 상태를 읽지 못함: ${reason(r)}`, fix: '`claude auth status`로 확인하세요.' };
}

async function codex(d: ReadinessDeps, versions: Map<Agent, string>): Promise<Check> {
  const v = await cliVersion(d, d.bins.codex, 'Codex CLI', 'Codex CLI를 설치하세요.');
  if (!('version' in v)) return v;
  versions.set('Codex', v.version);
  const r = await d.run(d.bins.codex, ['login', 'status']);
  if (runs(r)) return { status: 'ok', detail: `버전 ${v.version} · 로그인됨` };
  if (r.code === null) return { status: 'warn', detail: `버전 ${v.version} · 로그인 상태 확인 실패: ${reason(r)}`, fix: '`codex login status`로 확인하세요.' };
  return { status: 'fail', detail: `버전 ${v.version} · 로그인 안 됨`, fix: '`codex login`을 실행하세요.' };
}

async function tool(d: ReadinessDeps, bin: string, args: string[], name: string, missing: 'fail' | 'warn', fix: string): Promise<Check & { version?: string }> {
  const r = await d.run(bin, args);
  const version = runs(r) ? firstVersion(r.stdout) : null;
  if (!version) return { status: missing, detail: `${name} 없음: ${reason(r)}`, fix };
  return { status: 'ok', detail: `${name} ${version}`, version };
}

async function node(d: ReadinessDeps): Promise<Check> {
  const c = await tool(d, d.bins.node, ['--version'], 'Node.js', 'fail', 'Node.js를 설치하세요(.nvmrc 참고).');
  if (!c.version) return c;
  const [major = 0, minor = 0, patch = 0] = c.version.split('.').map((n) => Number.parseInt(n, 10));
  const [a, b, p] = NODE_RANGE.min;
  const tooOld = major < a || (major === a && (minor < b || (minor === b && patch < p)));
  if (tooOld || major >= NODE_RANGE.belowMajor) {
    return { status: 'warn', detail: `Node.js ${c.version} — 요구 범위 >=${NODE_RANGE.min.join('.')} <${String(NODE_RANGE.belowMajor)}`, fix: '`nvm install`(.nvmrc)으로 맞추세요.' };
  }
  return { status: 'ok', detail: c.detail };
}

async function pg(d: ReadinessDeps): Promise<Check> {
  if (!d.pg) return { status: 'warn', detail: '점검할 PostgreSQL 주소가 설정되지 않음', fix: '작업 저장소가 쓰는 DB 주소를 설정하세요.' };
  const target = `${d.pg.host}:${String(d.pg.port)}`;
  const r = await d.run(d.bins.pgIsReady, ['-h', d.pg.host, '-p', String(d.pg.port)]);
  if (runs(r)) return { status: 'ok', detail: `${target} 연결 가능` };
  if (r.code === null) return { status: 'warn', detail: `pg_isready를 실행하지 못함: ${reason(r)}`, fix: 'postgresql-client를 설치하세요.' };
  return { status: 'fail', detail: `${target} 연결 불가: ${reason(r)}`, fix: 'DB 컨테이너가 떠 있는지 확인하세요.' };
}

async function disk(d: ReadinessDeps): Promise<Check> {
  const free = (await d.diskFree(d.worktreeRoot)) / 1024 ** 3;
  const shown = `${d.worktreeRoot} 여유 ${free.toFixed(1)}GB`;
  if (free < DISK_FAIL_GB) return { status: 'fail', detail: shown, fix: '디스크 공간을 확보하세요.' };
  if (d.worktreeRoot.startsWith('/mnt/')) {
    return { status: 'warn', detail: `${shown} — Windows 드라이브(/mnt/…)는 느리고 pnpm 하드링크가 안 됩니다`, fix: 'AWBS_HOME을 WSL ext4(~ 아래)로 옮기세요.' };
  }
  if (free < DISK_WARN_GB) return { status: 'warn', detail: shown, fix: `${String(DISK_WARN_GB)}GB 이상 확보를 권장합니다.` };
  return { status: 'ok', detail: shown };
}

/** 서버 정책의 CLI 관측 등급에서 `verified`만 골라 obs 대조 목록으로 만든다. 정책이 없으면 undefined(확인 불가). */
export function verifiedFromPolicy(
  cliGrades: readonly { agent: Agent; version: string; model: string; options: string; grade: string }[] | undefined,
): ReadinessDeps['verifiedObservations'] {
  if (!cliGrades) return undefined;
  return cliGrades.filter((g) => g.grade === 'verified').map(({ agent, version, model, options }) => ({ agent, version, model, options }));
}

/**
 * cgroup 노출 여부. 상태를 정하지 않는 보조 정보다 — 노출됐다고 세션 측정이 되는 것은 아니다(M5-03에서 실증).
 * 준비 점검과 CLI 업데이트 보고가 같은 문구를 쓰도록 내보낸다(M4-05 M-1 표시 차이 정리).
 */
export async function cgroupNote(readFile: (path: string) => Promise<string>): Promise<string> {
  const text = await readFile('/sys/fs/cgroup/cgroup.controllers').catch(() => '');
  const have = new Set(text.trim().split(/\s+/));
  const lacking = ['cpu', 'memory', 'pids'].filter((c) => !have.has(c));
  return lacking.length === 0
    ? '참고: cgroup v2 cpu·memory·pids 노출됨(세션 측정 가능 여부는 M5-03에서 실증)'
    : `참고: cgroup v2 ${lacking.join('·')} 없음 — 프로세스 그룹 + /proc 합산으로 대신 관측(실증은 M5-03)`;
}

/**
 * G §6.7-8: 실행할 CLI 조합이 관측 검증된 조합과 같은가. 다르거나 확인할 수 없으면 warn —
 * 실행은 계속하되 관측은 참고만 하고 보유는 보수 계산(1+예산), 재검증을 기다린다. CLI를 구버전으로 돌리라고 안내하지 않는다(Q-12).
 */
async function obs(d: ReadinessDeps, versions: ReadonlyMap<Agent, string>): Promise<Check> {
  const note = await cgroupNote(d.readFile);
  return checkCliObservation(d.cliProfiles ?? [], d.verifiedObservations, versions, note);
}

/** 업데이트 직후에도 같은 조합 대조 규칙을 쓴다. 보유 수 계산과 등급 확정은 서버가 맡는다. */
export function checkCliObservation(
  profiles: NonNullable<ReadinessDeps['cliProfiles']>,
  verified: ReadinessDeps['verifiedObservations'],
  versions: ReadonlyMap<Agent, string>,
  note = '',
): Check {
  const conservative = '보수 계산(1+예산)으로 실행은 계속, 관측은 참고만 하고 재검증 대기';
  const fix = '최신 CLI를 그대로 쓰며, 이 조합의 관측 재검증이 등록되면 경고가 풀립니다.';
  if (profiles.length === 0) return { status: 'warn', detail: `실행 조합(모델·옵션) 설정이 없어 관측 검증 여부를 확인할 수 없음 — 미검증으로 봄, ${conservative}. ${note}`, fix };
  if (!verified) return { status: 'warn', detail: `관측 검증 목록이 없어 확인할 수 없음 — 미검증으로 봄, ${conservative}. ${note}`, fix };
  const rows = profiles.map((p) => {
    const version = versions.get(p.agent);
    const label = `${p.agent} ${version ?? '버전 확인 불가'} · ${p.model} · ${p.options}`;
    const ok = version !== undefined && verified.some((v) => v.agent === p.agent && v.version === version && v.model === p.model && v.options === p.options);
    return { label, ok };
  });
  const unverified = rows.filter((r) => !r.ok).map((r) => r.label);
  if (unverified.length > 0) return { status: 'warn', detail: `미검증: ${unverified.join(', ')} — ${conservative}. ${note}`, fix };
  return { status: 'ok', detail: `관측 검증된 조합: ${rows.map((r) => r.label).join(', ')}. ${note}` };
}

const notChecked = (what: string): Check => ({ status: 'warn', detail: `${what} 점검이 아직 연결되지 않음(확인 안 함)` });

export async function checkReadiness(d: ReadinessDeps, now: Date): Promise<ReadinessReport> {
  const versions = new Map<Agent, string>();
  const strip = async (c: Promise<Check & { version?: string }>): Promise<Check> => {
    const rest = { ...(await c) };
    delete rest.version;
    return rest;
  };
  const checks: Record<EnvironmentKey, () => Promise<Check>> = {
    claude: () => claude(d, versions),
    codex: () => codex(d, versions),
    git: () => strip(tool(d, d.bins.git, ['--version'], 'git', 'fail', 'git을 설치하세요.')),
    node: () => node(d),
    pnpm: () => strip(tool(d, d.bins.pnpm, ['--version'], 'pnpm', 'fail', '`corepack enable` 후 pnpm을 설치하세요.')),
    pg: () => pg(d),
    repo: () => (d.probes.repo ?? (() => Promise.resolve(notChecked('작업 저장소'))))(),
    disk: () => disk(d),
    subs: () => (d.probes.subs ?? (() => Promise.resolve(notChecked('하위 Agent 정의 동기화'))))(),
    // CLI 버전을 알아야 하므로 아래에서 다른 점검이 끝난 뒤 따로 돈다.
    obs: () => obs(d, versions),
    gh: () => strip(tool(d, d.bins.gh, ['--version'], 'GitHub CLI(gh)', 'warn', 'gh 로그인 방식을 쓰려면 gh를 설치하세요.')),
    lfs: () => strip(tool(d, d.bins.git, ['lfs', 'version'], 'git-lfs', 'warn', 'LFS 파일이 있는 저장소를 쓰려면 git-lfs를 설치하세요.')),
    // 야간 화면 비교의 고정 글꼴(M7-03 결정 12). 없으면 warn이고 화면 비교는 「비교 불가」가 된다. 실행은 멈추지 않는다.
    font: () => checkBaselineFont(d.run),
  };
  const runCheck = async (key: EnvironmentKey): Promise<ReadinessItem> => {
    try {
      return { key, ...(await checks[key]()) };
    } catch (e) {
      return { key, status: 'fail', detail: `점검 중 오류: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
    }
  };
  const first = await Promise.all(KEYS.filter((k) => k !== 'obs').map(runCheck));
  const obsItem = await runCheck('obs');
  const items = KEYS.map((k) => (k === 'obs' ? obsItem : first.find((i) => i.key === k))).filter((i): i is ReadinessItem => i !== undefined);
  const cli = (d.cliProfiles ?? []).flatMap((p) => {
    const version = versions.get(p.agent);
    return version ? [{ agent: p.agent, version, model: p.model, options: p.options }] : [];
  });
  return { at: now.toISOString(), items, ...(cli.length > 0 && { cli }) };
}

/** fail 항목 때문에 실행을 멈출 Agent. CLI 항목은 그 Agent만, 공통 항목은 둘 다. */
export function blockedAgents(items: readonly Pick<ReadinessItem, 'key' | 'status'>[]): Agent[] {
  const out = new Set<Agent>();
  for (const i of items) {
    if (i.status !== 'fail') continue;
    if (i.key === 'claude') out.add('Claude');
    else if (i.key === 'codex') out.add('Codex');
    else {
      out.add('Claude');
      out.add('Codex');
    }
  }
  return (['Claude', 'Codex'] as const).filter((a) => out.has(a));
}

/**
 * 바로 한 번, 이후 끝난 시점부터 intervalMs마다. 겹쳐 돌리지 않는다.
 * `stop()`은 다음 실행을 취소하고, 이미 실행 중인 작업이 끝날 때까지 기다린다(M4 통합 교차 리뷰 P1-4).
 * 왜: 종료 뒤에도 이전 실행의 보고·CLI 설치가 계속되면 같은 홈의 새 Runner와 겹칠 수 있다.
 */
export function scheduleDaily(
  task: () => Promise<void>,
  { intervalMs = 24 * 3600_000, onError = () => undefined }: { intervalMs?: number; onError?: (e: unknown) => void } = {},
): { stop(): Promise<void> } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running: Promise<void> | undefined;
  const loop = async () => {
    if (stopped) return;
    try {
      await task();
    } catch (e) {
      onError(e);
    }
    if (!stopped) timer = setTimeout(() => { running = loop(); }, intervalMs);
  };
  timer = setTimeout(() => { running = loop(); }, 0);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
