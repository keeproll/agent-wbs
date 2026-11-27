import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { CommandResult } from '../../readiness/command.ts';
import type { Redact } from '../../security/redact.ts';
import { atomicWrite } from '../../state/files.ts';
import type { Timing } from './perf.ts';
import type { TestOutcome } from './tests.ts';

/**
 * ③④의 실행기. ①②의 실행기에 환경 변수(env)를 더 받는다.
 * Q-08 확정 전에는 fake만 전달한다. 프로세스 등록·중단·자손 종료 확인 뒤 반환해야 한다.
 */
export type CiExecute = (argv: readonly string[], cwd: string, signal?: AbortSignal, env?: Record<string, string>) => Promise<CommandResult>;

/** 단계 명령이 `AWBS_REPORT` 파일에 남기는 결과. 모든 경로는 단계 폴더(`AWBS_EVIDENCE_DIR`) 기준 상대 경로다. */
export interface StepReport {
  tests?: TestOutcome[];
  /** 앱 화면 스크린샷만 가리킨다. 비교 기준 이미지는 main 정의(screens)에만 있다. */
  screens?: { name: string; actual: string }[];
  timings?: Timing[];
  screenshots?: string[];
}
export interface StepAttempt { result: CommandResult; report: StepReport | null; reportError: string | null; log: string }

const KEYS = ['nonce', 'tests', 'screens', 'timings', 'screenshots'];
const MAX_FILE = 50 * 1024 * 1024;
const MAX_REPORT = 4 * 1024 * 1024;
const text = (value: unknown): value is string => typeof value === 'string' && value !== '';
const only = (item: Record<string, unknown>, keys: string[]) => Object.keys(item).every(k => keys.includes(k));

function parseReport(value: unknown, nonce: string): StepReport {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !KEYS.includes(k))) throw new TypeError('보고서 형식이 올바르지 않습니다.');
  const report = { ...value as Record<string, unknown> };
  // 이번 시도에 준 nonce가 그대로 들어 있어야 이번 시도의 보고서다. 예전 실행·다른 시도의 보고서를 읽지 않는다(재리뷰 원칙 3).
  if (report.nonce !== nonce) throw new TypeError('보고서의 nonce가 이번 시도의 값과 다릅니다(예전 보고서이거나 nonce를 적지 않음).');
  delete report.nonce;
  const list = (key: string, check: (item: Record<string, unknown>) => boolean) => {
    const items = report[key];
    if (items === undefined) return;
    if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || !check(item as Record<string, unknown>))) throw new TypeError(`보고서의 ${key}가 올바르지 않습니다.`);
  };
  list('tests', t => only(t, ['key', 'status']) && text(t.key) && (t.status === 'pass' || t.status === 'fail'));
  // 기준 이미지(expected)와 기준 시간(budgetMs)은 받지 않는다. 기준은 main 정의에만 있다(조정자 결정 3, 원칙 A).
  list('screens', s => only(s, ['name', 'actual']) && text(s.name) && text(s.actual));
  list('timings', t => only(t, ['name', 'samplesMs']) && text(t.name) && Array.isArray(t.samplesMs));
  if (report.screenshots !== undefined && (!Array.isArray(report.screenshots) || !report.screenshots.every(text))) throw new TypeError('보고서의 screenshots가 올바르지 않습니다.');
  return report as StepReport;
}

/** 실제 폴더인지 확인한다. 없으면 만들고, symlink면 거부한다. */
async function realDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error(`근거 폴더가 올바르지 않습니다: ${path}`);
}

/** 링크를 따라가지 않고 일반 파일만 연다(O_NOFOLLOW). 연 파일로 다시 확인해 확인과 읽기 사이에 바뀌는 것을 막는다. */
async function readNoFollow(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new TypeError('근거 파일은 크기 제한 안의 일반 파일이어야 합니다.');
    return await file.readFile();
  } finally { await file.close(); }
}

/**
 * 실행 하나의 근거 폴더(`<AWBS_HOME>/runs/<실행 ID>/`). 저장소 밖이라 검사 사본·Agent 폴더와 섞이지 않는다.
 * - `step/`: 단계 명령에게 주는 폴더(`AWBS_EVIDENCE_DIR`). 단계가 만든 것은 읽기만 하고 믿지 않는다.
 * - `runner/`: Runner만 쓰는 폴더(로그·run.json). 새 파일만 만들고(O_EXCL) 링크를 따라가지 않는다(O_NOFOLLOW).
 * 왜: 단계가 미리 심은 링크를 Runner가 따라가 쓰면 다른 작업의 근거를 덮어쓴다(원칙 A).
 */
export class Evidence {
  readonly root: string;
  readonly runId: string;
  readonly stepDir: string;
  readonly runnerDir: string;
  private readonly home: string;
  private readonly redact: Redact;
  private readonly files = new Set<string>();
  private constructor(home: string, runId: string, root: string, redact: Redact) {
    this.home = home; this.runId = runId; this.root = root; this.redact = redact;
    this.stepDir = join(root, 'step'); this.runnerDir = join(root, 'runner');
  }

  static async open(home: string, runId: string, redact: Redact): Promise<Evidence> {
    if (!/^[0-9a-f-]{36}$/.test(runId)) throw new TypeError('실행 ID가 올바르지 않습니다.');
    await realDirectory(home);
    await realDirectory(join(home, 'runs'));
    const evidence = new Evidence(home, runId, join(home, 'runs', runId), redact);
    for (const path of [evidence.root, evidence.runnerDir, evidence.stepDir]) await realDirectory(path);
    return evidence;
  }

  /** 서버에는 위치만 보낸다(DB에는 위치와 요약만, G L488). AWBS_HOME 기준 상대 경로다. */
  private location(path: string): string { return relative(this.home, path).split(sep).join('/'); }
  get artifacts(): string[] { return [...this.files].map(path => this.location(path)); }

  private async ownFolder(): Promise<void> {
    for (const path of [this.root, this.runnerDir]) if (!(await lstat(path)).isDirectory()) throw new Error('Runner 근거 폴더가 바뀌었습니다.');
  }

  /** 같은 이름이 이미 있으면(재시작·단계가 심은 링크) 덮어쓰지 않고 다른 이름으로 새 파일을 만든다. */
  private async create(name: string, content: string): Promise<string> {
    await this.ownFolder();
    for (let n = 1; n < 100; n++) {
      const path = join(this.runnerDir, n === 1 ? name : name.replace(/(\.[a-z]+)$/, `~${String(n)}$1`));
      try {
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(content); } finally { await file.close(); }
        return path;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    throw new Error('근거 파일 이름을 만들지 못했습니다.');
  }

  /** 단계 폴더 안의 일반 파일만 읽는다. 중간 폴더가 링크라서 단계 폴더 밖으로 나가면 거부한다. */
  async file(path: string): Promise<Buffer> {
    if (!text(path)) throw new TypeError('근거 파일 경로가 올바르지 않습니다.');
    const target = join(this.stepDir, path);
    const parent = await realpath(dirname(target));
    const root = await realpath(this.stepDir);
    if (parent !== root && !parent.startsWith(root + sep)) throw new TypeError('근거 파일이 단계 폴더 밖에 있습니다.');
    const content = await readNoFollow(target, MAX_FILE);
    this.files.add(target);
    return content;
  }

  async run(execute: CiExecute, argv: readonly string[], cwd: string, label: string, env: Record<string, string>, signal?: AbortSignal): Promise<StepAttempt> {
    // 이번 시도만의 새 경로와 nonce를 준다. 옛 보고서는 지우지 않고(다른 단계의 근거일 수 있다) 읽지도 않는다(재리뷰 원칙 3).
    // 정리는 이번 시도의 정확한 경로만 한다. 새 무작위 경로라 보통 없지만, 있으면 링크든 파일이든 그 이름 자체만 지운다.
    const nonce = randomUUID();
    const reportPath = join(this.stepDir, `${label}-${nonce}.report.json`);
    await unlink(reportPath).catch(() => undefined);
    let result: CommandResult;
    try {
      result = await execute(argv, cwd, signal, { ...env, AWBS_REPORT: reportPath, AWBS_REPORT_NONCE: nonce, AWBS_EVIDENCE_DIR: this.stepDir });
    } catch (error) {
      result = { code: null, stdout: '', stderr: error instanceof Error ? error.message : '실행하지 못했습니다.' };
    }
    result = this.redact(result);
    const log = await this.create(`${label}.log`, `$ ${argv.join(' ')}\nexit ${String(result.code)}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}\n`);
    this.files.add(log);
    let report: StepReport | null = null; let reportError: string | null = null;
    try {
      if (await lstat(reportPath).catch(() => null)) {
        report = parseReport(JSON.parse((await readNoFollow(reportPath, MAX_REPORT)).toString('utf8')) as unknown, nonce);
        this.files.add(reportPath);
      }
    } catch (error) { reportError = error instanceof Error ? error.message : '보고서를 읽지 못했습니다.'; }
    return { result, report, reportError, log };
  }

  async finish(meta: Record<string, unknown>): Promise<void> {
    await this.ownFolder();
    // rename은 같은 이름의 링크를 따라가지 않고 링크 자체를 바꾼다.
    await atomicWrite(this.runnerDir, 'run.json', `${JSON.stringify({ runId: this.runId, ...meta })}\n`);
  }
}

/** 로그 발췌는 끝부분만 DB로 보낸다. 원문은 Runner PC의 근거 폴더에 있다. */
export function excerpt(result: CommandResult, extra: string | null = null, limit = 4000): string {
  const value = [extra, result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  return value.length > limit ? value.slice(-limit) : value;
}
