import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
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

/** 단계 명령이 `AWBS_REPORT` 파일에 남기는 결과. 모든 경로는 근거 폴더(`AWBS_EVIDENCE_DIR`) 기준 상대 경로다. */
export interface StepReport {
  tests?: TestOutcome[];
  screens?: { name: string; actual: string; expected: string }[];
  timings?: Timing[];
  screenshots?: string[];
}
export interface StepAttempt { result: CommandResult; report: StepReport | null; reportError: string | null; log: string }

const KEYS = ['tests', 'screens', 'timings', 'screenshots'];
const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

function parseReport(value: unknown): StepReport {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !KEYS.includes(k))) throw new TypeError('보고서 형식이 올바르지 않습니다.');
  const report = value as Record<string, unknown>;
  const list = (key: string, check: (item: Record<string, unknown>) => boolean) => {
    const items = report[key];
    if (items === undefined) return;
    if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || !check(item as Record<string, unknown>))) throw new TypeError(`보고서의 ${key}가 올바르지 않습니다.`);
  };
  list('tests', t => text(t.key) && (t.status === 'pass' || t.status === 'fail'));
  list('screens', s => text(s.name) && text(s.actual) && text(s.expected));
  // 기준(budgetMs)은 받지 않는다. 기준은 main 정의에만 있다(조정자 결정 3).
  list('timings', t => Object.keys(t).every(k => k === 'name' || k === 'samplesMs') && text(t.name) && Array.isArray(t.samplesMs));
  if (report.screenshots !== undefined && (!Array.isArray(report.screenshots) || !report.screenshots.every(text))) throw new TypeError('보고서의 screenshots가 올바르지 않습니다.');
  return report as StepReport;
}

/** 실행 하나의 근거 폴더(`<AWBS_HOME>/runs/<실행 ID>/`). 저장소 밖이라 검사 사본·Agent 폴더와 섞이지 않는다. */
export class Evidence {
  readonly root: string;
  readonly runId: string;
  private readonly home: string;
  private readonly redact: Redact;
  private readonly files = new Set<string>();
  private constructor(home: string, runId: string, root: string, redact: Redact) { this.home = home; this.runId = runId; this.root = root; this.redact = redact; }

  static async open(home: string, runId: string, redact: Redact): Promise<Evidence> {
    if (!/^[0-9a-f-]{36}$/.test(runId)) throw new TypeError('실행 ID가 올바르지 않습니다.');
    const runs = join(home, 'runs');
    await mkdir(runs, { recursive: true, mode: 0o700 });
    if (!(await lstat(runs)).isDirectory()) throw new Error('근거 폴더가 올바르지 않습니다.');
    const root = join(runs, runId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory()) throw new Error('근거 폴더가 올바르지 않습니다.');
    return new Evidence(home, runId, root, redact);
  }

  /** 서버에는 위치만 보낸다(DB에는 위치와 요약만, G L488). AWBS_HOME 기준 상대 경로다. */
  location(path: string): string { return relative(this.home, join(this.root, path)).split(sep).join('/'); }
  get artifacts(): string[] { return [...this.files].map(path => this.location(path)); }
  keep(path: string): void { this.files.add(path); }

  /** 보고서가 가리킨 파일을 근거 폴더 안의 일반 파일로만 받는다. 왜: 단계가 다른 파일(비밀값 등)을 근거로 올리지 못하게 한다. */
  async file(path: string): Promise<Buffer> {
    if (!text(path)) throw new TypeError('근거 파일 경로가 올바르지 않습니다.');
    const target = join(this.root, path);
    const stat = await lstat(target);
    if (!stat.isFile()) throw new TypeError('근거 파일은 일반 파일이어야 합니다.');
    const real = await realpath(target);
    if (!real.startsWith(await realpath(this.root) + sep)) throw new TypeError('근거 파일이 근거 폴더 밖에 있습니다.');
    this.keep(path);
    return readFile(target);
  }

  async run(execute: CiExecute, argv: readonly string[], cwd: string, label: string, env: Record<string, string>, signal?: AbortSignal): Promise<StepAttempt> {
    const reportPath = join(this.root, `${label}.report.json`);
    let result: CommandResult;
    try {
      result = await execute(argv, cwd, signal, { ...env, AWBS_REPORT: reportPath, AWBS_EVIDENCE_DIR: this.root });
    } catch (error) {
      result = { code: null, stdout: '', stderr: error instanceof Error ? error.message : '실행하지 못했습니다.' };
    }
    result = this.redact(result);
    const log = `${label}.log`;
    await writeFile(join(this.root, log), `$ ${argv.join(' ')}\nexit ${String(result.code)}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}\n`, { mode: 0o600 });
    this.keep(log);
    let report: StepReport | null = null; let reportError: string | null = null;
    try {
      const stat = await lstat(reportPath).catch(() => null);
      if (stat) {
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new TypeError('보고서는 4 MiB 이하 일반 파일이어야 합니다.');
        report = parseReport(JSON.parse(await readFile(reportPath, 'utf8')) as unknown);
        this.keep(`${label}.report.json`);
      }
    } catch (error) { reportError = error instanceof Error ? error.message : '보고서를 읽지 못했습니다.'; }
    return { result, report, reportError, log };
  }

  async finish(meta: Record<string, unknown>): Promise<void> {
    await atomicWrite(this.root, 'run.json', `${JSON.stringify({ runId: this.runId, ...meta })}\n`);
  }
}

/** 로그 발췌는 끝부분만 DB로 보낸다. 원문은 Runner PC의 근거 폴더에 있다. */
export function excerpt(result: CommandResult, extra: string | null = null, limit = 4000): string {
  const value = [extra, result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  return value.length > limit ? value.slice(-limit) : value;
}
