import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Agent = 'claude' | 'codex';

export interface Scenario {
  /** stdout에 한 줄씩 그대로 쓴다. 객체는 JSON으로 쓴다. */
  lines?: unknown[];
  stderr?: string;
  /** 각 줄 사이 대기 */
  delayMs?: number;
  exitCode?: number;
  /** 모두 쓴 뒤 종료하지 않는다(강제 종료 시험). */
  hang?: boolean;
  /** SIGTERM을 무시한다. hang과 함께 쓴다. */
  ignoreSigterm?: boolean;
  /** stdout 파이프만 닫고 프로세스는 계속 실행한다. */
  closeStdout?: boolean;
}

export interface Call {
  argv: string[];
  cwd: string;
  /** 값은 남기지 않는다. 환경 변수 이름만 확인한다. */
  envNames: string[];
  stdin: string;
}

export interface FakeCli {
  path: string;
  calls(): Call[];
}

/**
 * 실제 CLI와 같은 이름의 실행 파일을 dir에 만든다. 과금·네트워크가 없다.
 * Runner가 AWBS_* 환경 변수를 제거하므로 시나리오는 실행 파일 옆의 파일로 전달한다.
 */
export function installFakeCli(dir: string, agent: Agent, scenario?: Scenario): FakeCli {
  mkdirSync(dir, { recursive: true });
  const scenarioPath = join(dir, `${agent}.scenario.json`);
  const callsPath = join(dir, `${agent}.calls.jsonl`);
  const path = join(dir, agent);
  writeFileSync(scenarioPath, JSON.stringify(scenario ?? defaultScenario(agent)));
  writeFileSync(callsPath, '');
  const script = join(import.meta.dirname, 'cli-main.ts');
  const args = [process.execPath, script, scenarioPath, callsPath].map((v) => `'${v.replaceAll("'", `'\\''`)}'`);
  writeFileSync(path, `#!/bin/sh\nexec ${args.join(' ')} "$@"\n`);
  chmodSync(path, 0o755);
  return {
    path,
    calls: () =>
      readFileSync(callsPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call),
  };
}

function defaultScenario(agent: Agent): Scenario {
  const file = join(import.meta.dirname, agent, 'success.jsonl');
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  return { lines };
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** 테스트용 실행. 실제 실행 계층(M5)은 여기에 두지 않는다. */
export function runCli(
  path: string,
  args: string[],
  options: { stdin?: string; env?: NodeJS.ProcessEnv; cwd?: string; onFirstOutput?: (child: ChildProcess) => void } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { env: options.env ?? { PATH: '/usr/bin:/bin' },...(options.cwd && { cwd:options.cwd }) });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.stdout.once('data', () => options.onFirstOutput?.(child));
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin ?? '');
  });
}
