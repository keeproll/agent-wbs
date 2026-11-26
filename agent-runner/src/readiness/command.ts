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
}

export function createRunCommand({ env, timeoutMs = 20_000, maxBytes = 4 * 1024 * 1024 }: RunCommandOptions): RunCommand {
  return (cmd, args) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let reason = '';
      const keep = (buf: Buffer[], used: number, chunk: Buffer): number => {
        const room = maxBytes - used;
        if (room > 0) buf.push(chunk.subarray(0, room));
        return used + Math.min(room > 0 ? room : 0, chunk.length);
      };
      child.stdout.on('data', (c: Buffer) => (outBytes = keep(out, outBytes, c)));
      child.stderr.on('data', (c: Buffer) => (errBytes = keep(err, errBytes, c)));
      const timer = setTimeout(() => {
        reason = `시간 초과(${String(timeoutMs)}ms)`;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', (e) => {
        reason = e.message;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const stderr = Buffer.concat(err).toString('utf8');
        resolve({
          code: reason ? null : code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: reason ? `${stderr}${stderr ? '\n' : ''}${reason}` : stderr,
        });
      });
    });
}
