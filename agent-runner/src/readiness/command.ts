import { spawn } from 'node:child_process';

/** 점검 명령 1회의 결과. 실행하지 못했거나 시간이 지나면 code가 null이고 stderr에 사유가 있다. */
export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 명령과 인자를 배열로 받는다. shell 문자열 조합을 하지 않는다(architecture §4 「명령 실행」). */
export type RunCommand = (cmd: string, args: readonly string[]) => Promise<CommandResult>;

/**
 * 점검 명령에 넘기는 환경 변수 허용 목록. CLI가 설정·로그인 정보를 찾는 데 필요한 것만 둔다.
 * Runner·GitHub 토큰, SSH agent, `AWBS_*`는 넘기지 않는다(architecture §4 「Agent 환경 변수」, G §9.5-4-1).
 */
const ALLOWED_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];

export function probeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of ALLOWED_ENV) if (env[name] !== undefined) out[name] = env[name];
  return out;
}

export interface RunCommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** stdout·stderr 각각 이 바이트까지만 모은다. */
  maxBytes?: number;
  /** 직접 실행한 프로세스가 끝난 뒤, 자손이 쥔 출력 파이프가 닫히기를 기다리는 시간 */
  exitGraceMs?: number;
}

/** 프로세스 그룹 전체에 신호를 보낸다. 이미 없으면 무시한다. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 이미 끝난 그룹
  }
}

/**
 * 점검 명령은 자기 프로세스 그룹(detached)으로 실행한다. 시간이 지나거나, 직접 실행한 프로세스가 끝났는데
 * 자손이 출력 파이프를 쥐고 남아 있으면 그룹 전체를 죽이고 바로 결과를 돌려준다(리뷰 6).
 * 그래서 어떤 경우에도 `timeoutMs`(+ 짧은 유예) 안에 끝나고 자손이 남지 않는다.
 */
export function createRunCommand({ env, timeoutMs = 20_000, maxBytes = 4 * 1024 * 1024, exitGraceMs = 300 }: RunCommandOptions): RunCommand {
  return (cmd, args) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let reason = '';
      let exitCode: number | null = null;
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const keep = (buf: Buffer[], used: number, chunk: Buffer): number => {
        const room = maxBytes - used;
        if (room > 0) buf.push(chunk.subarray(0, room));
        return used + Math.min(room > 0 ? room : 0, chunk.length);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        killGroup(child.pid);
        child.stdout.destroy();
        child.stderr.destroy();
        const stderr = Buffer.concat(err).toString('utf8');
        resolve({
          code: reason ? null : exitCode,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: reason ? `${stderr}${stderr ? '\n' : ''}${reason}` : stderr,
        });
      };
      child.stdout.on('data', (c: Buffer) => (outBytes = keep(out, outBytes, c)));
      child.stderr.on('data', (c: Buffer) => (errBytes = keep(err, errBytes, c)));
      const timer = setTimeout(() => {
        reason = `시간 초과(${String(timeoutMs)}ms)`;
        finish();
      }, timeoutMs);
      child.on('error', (e) => {
        reason = e.message;
        finish();
      });
      child.on('exit', (code) => {
        exitCode = code;
        graceTimer = setTimeout(finish, exitGraceMs);
      });
      child.on('close', (code) => {
        exitCode ??= code;
        finish();
      });
    });
}
