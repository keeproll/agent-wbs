// 사용자 scope 시험(probeUserScope)의 가짜 응답. 실제 scope 안이었다면 나왔을 cgroup 종류·경로를 그대로 돌려준다.
import type { CommandResult } from '../../src/readiness/command.ts';
import { scopeCgroupPath } from '../../src/exec/scope.ts';

/** probe 명령(`/usr/bin/env … systemd-run … --unit=<u> -- /bin/sh -c …`)이면 정상 응답, 아니면 undefined. */
export function scopeProbeReply(cmd: string, args: readonly string[]): CommandResult | undefined {
  if (cmd !== '/usr/bin/env') return undefined;
  const unit = args.find((a) => a.startsWith('--unit='))?.slice('--unit='.length);
  if (!unit) return undefined;
  return { code: 0, stdout: `cgroup2fs\n0::${scopeCgroupPath(unit)}\n`, stderr: '' };
}
