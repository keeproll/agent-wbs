import { createHash } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, hostname, release } from 'node:os';
import type { ApiRequest } from '../api/client.ts';

/** POST /runner/host 본문 */
export type HostReport = ApiRequest<'reportHost'>['body'];

/** 사양을 읽는 곳. 테스트는 가짜 파일 내용을 넣는다. */
export interface HostSources {
  readFile(path: string): Promise<string>;
  hostname(): string;
  kernel(): string;
  /** `nproc`와 같은 값 */
  cores(): number;
  /** 그 경로가 있는 파일 시스템의 사용 가능 바이트(`df`의 Available) */
  diskFree(path: string): Promise<number>;
}

export function nodeHostSources(): HostSources {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    hostname,
    kernel: release,
    cores: availableParallelism,
    diskFree: async (path) => {
      const s = await statfs(path);
      return s.bavail * s.bsize;
    },
  };
}

const KIB_PER_GIB = 1024 * 1024;
/** 크게 보고하면 상한이 부풀므로 버림한다. */
const gb = (n: number): number => Math.floor(n * 100 + 1e-9) / 100;

/** /proc/meminfo의 kB 값. WSL에서는 Windows가 WSL에 할당한 양이다(G §6.6). */
function meminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m?.[1] && m[2]) out[m[1]] = Number(m[2]);
  }
  return out;
}

function need(info: Record<string, number>, key: string): number {
  const v = info[key];
  if (v === undefined) throw new Error(`/proc/meminfo에 ${key}가 없습니다.`);
  return v;
}

async function nonEmpty(src: HostSources, path: string): Promise<string> {
  const v = (await src.readFile(path)).trim();
  if (!v) throw new Error(`${path}가 비어 있습니다.`);
  return v;
}

/** 관측한 세션 메모리의 평균. 관측 전에는 보고하지 않고 서버가 초기값 1GB를 쓴다. */
export class SessionMemory {
  #sum = 0;
  #n = 0;

  record(gbUsed: number): void {
    if (!Number.isFinite(gbUsed) || gbUsed <= 0) return;
    this.#sum += gbUsed;
    this.#n += 1;
  }

  report(): { perSessionGB?: number; samples?: number } {
    return this.#n === 0 ? {} : { perSessionGB: gb(this.#sum / this.#n), samples: this.#n };
  }
}

/**
 * Runner 시작·PC 변경 시 보고할 사양.
 * 머신 식별자는 hostname + machine-id의 SHA-256 앞 16자리다. machine-id 원문은 내보내지 않는다.
 */
export async function collectHost(src: HostSources, worktreeRoot: string, sessions?: SessionMemory): Promise<HostReport> {
  const machineId = await nonEmpty(src, '/etc/machine-id');
  const bootId = await nonEmpty(src, '/proc/sys/kernel/random/boot_id');
  const mem = meminfo(await src.readFile('/proc/meminfo'));
  const cpuinfo = await src.readFile('/proc/cpuinfo').catch(() => '');
  const osRelease = await src.readFile('/etc/os-release').catch(() => '');

  const cpu = /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim() ?? '알 수 없음';
  const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(osRelease)?.[1] ?? 'Linux';
  return {
    hostId: `${src.hostname()}-${createHash('sha256').update(machineId).digest('hex').slice(0, 16)}`,
    bootId,
    cpu,
    cores: src.cores(),
    memGB: gb(need(mem, 'MemTotal') / KIB_PER_GIB),
    swapGB: gb(need(mem, 'SwapTotal') / KIB_PER_GIB),
    diskFreeGB: gb((await src.diskFree(worktreeRoot)) / 1024 ** 3),
    os: `${pretty} (${src.kernel()})`,
    ...sessions?.report(),
  };
}

/** 동시 실행 보고·조절에 쓰는 순간 자원 값 */
export async function sampleResources(src: HostSources): Promise<{ memFreeGB: number; swapUsedGB: number }> {
  const mem = meminfo(await src.readFile('/proc/meminfo'));
  return {
    memFreeGB: gb(need(mem, 'MemAvailable') / KIB_PER_GIB),
    swapUsedGB: gb(Math.max(0, need(mem, 'SwapTotal') - need(mem, 'SwapFree')) / KIB_PER_GIB),
  };
}

/** /proc/stat 첫 줄 두 번 사이의 CPU 사용률(%). 첫 측정은 기준이 없어 0이다. */
export class CpuMeter {
  #prev: { busy: number; idle: number } | null = null;

  sample(stat: string): number {
    const fields = /^cpu\s+(.+)$/m.exec(stat)?.[1]?.trim().split(/\s+/).map(Number) ?? [];
    // user nice system idle iowait irq softirq steal …
    const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
    const busy = fields.reduce((a, b) => a + b, 0) - idle;
    const prev = this.#prev;
    this.#prev = { busy, idle };
    if (!prev) return 0;
    const total = busy - prev.busy + (idle - prev.idle);
    return total <= 0 ? 0 : Math.round(((busy - prev.busy) / total) * 1000) / 10;
  }
}
