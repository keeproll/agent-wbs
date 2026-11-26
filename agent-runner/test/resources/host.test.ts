import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { memoryPressure } from '../../src/resources/concurrency.ts';
import { CpuMeter, SessionMemory, collectHost, nodeHostSources, sampleResources, type HostSources } from '../../src/resources/host.ts';

const GiB = 1024 ** 3;
const meminfo = (total: number, avail: number, swapTotal: number, swapFree: number) =>
  `MemTotal:       ${String(total)} kB\nMemFree:  1 kB\nMemAvailable:   ${String(avail)} kB\nSwapTotal:       ${String(swapTotal)} kB\nSwapFree:       ${String(swapFree)} kB\n`;

function fake(files: Record<string, string>, extra: Partial<HostSources> = {}): HostSources {
  return {
    readFile: (path) => {
      const v = files[path];
      return v === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(v);
    },
    hostname: () => 'KEEPROLL-PC',
    kernel: () => '6.18.58.1-microsoft-standard-WSL2',
    cores: () => 20,
    diskFree: () => Promise.resolve(976650996 * 1024),
    ...extra,
  };
}

const FILES = {
  '/proc/meminfo': meminfo(24608616, 21206612, 4194304, 4194304),
  '/proc/cpuinfo': 'processor\t: 0\nmodel name\t: Intel(R) Core(TM) Ultra 7 265K\nflags\t: x\n\nprocessor\t: 1\nmodel name\t: Intel(R) Core(TM) Ultra 7 265K\n',
  '/etc/machine-id': 'd177aaaabbbbccccddddeeeeffff0000\n',
  '/proc/sys/kernel/random/boot_id': 'da1a6eb2-9f27-4156-8dfb-d5d785314838\n',
  '/etc/os-release': 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n',
};

describe('collectHost — POST /runner/host 본문(G §6.6 「Runner가 확인·보고하는 사양」)', () => {
  test('사양을 모아 계약 형식으로 만든다', async () => {
    const body = await collectHost(fake(FILES), '/home/u/.agentwbs');
    const digest = createHash('sha256').update('d177aaaabbbbccccddddeeeeffff0000').digest('hex').slice(0, 16);
    expect(body).toEqual({
      hostId: `KEEPROLL-PC-${digest}`,
      bootId: 'da1a6eb2-9f27-4156-8dfb-d5d785314838',
      cpu: 'Intel(R) Core(TM) Ultra 7 265K',
      cores: 20,
      memGB: 23.46,
      swapGB: 4,
      diskFreeGB: 931.4,
      os: 'Ubuntu 24.04.1 LTS (6.18.58.1-microsoft-standard-WSL2)',
    });
  });

  test('머신 식별자에 machine-id 원문을 싣지 않는다', async () => {
    const body = await collectHost(fake(FILES), '/w');
    expect(JSON.stringify(body)).not.toContain('d177aaaa');
  });

  test('machine-id가 다르면 hostId가 다르다(PC 변경 인식)', async () => {
    const a = await collectHost(fake(FILES), '/w');
    const b = await collectHost(fake({ ...FILES, '/etc/machine-id': 'ffff\n' }), '/w');
    expect(a.hostId).not.toBe(b.hostId);
  });

  test('관측한 세션 평균 메모리가 있으면 함께 보낸다', async () => {
    const mem = new SessionMemory();
    expect(mem.report()).toEqual({});
    mem.record(1.5);
    mem.record(2.5);
    const body = await collectHost(fake(FILES), '/w', mem);
    expect(body).toMatchObject({ perSessionGB: 2, samples: 2 });
  });

  test('worktree 위치의 디스크 여유를 잰다', async () => {
    const seen: string[] = [];
    await collectHost(fake(FILES, { diskFree: (p) => (seen.push(p), Promise.resolve(50 * GiB)) }), '/home/u/.agentwbs');
    expect(seen).toEqual(['/home/u/.agentwbs']);
  });

  test.each([
    ['/etc/machine-id', '  \n'],
    ['/proc/sys/kernel/random/boot_id', ''],
    ['/proc/meminfo', 'MemFree: 1 kB\n'],
  ])('%s를 읽을 수 없으면 보고하지 않고 오류', async (path, text) => {
    await expect(collectHost(fake({ ...FILES, [path]: text }), '/w')).rejects.toThrow();
  });

  test('cpuinfo에 model name이 없으면 「알 수 없음」', async () => {
    const body = await collectHost(fake({ ...FILES, '/proc/cpuinfo': 'processor: 0\n' }), '/w');
    expect(body.cpu).toBe('알 수 없음');
  });
});

describe('sampleResources — /runner/concurrency resources', () => {
  test('여유 메모리는 MemAvailable, swap은 사용량(전체−여유)', async () => {
    const src = fake({ ...FILES, '/proc/meminfo': meminfo(8 * 1048576, 3 * 1048576, 2 * 1048576, 1.5 * 1048576) });
    expect(await sampleResources(src)).toEqual({ memFreeGB: 3, swapUsedGB: 0.5 });
  });
});

describe('리뷰 4·7 — 판단 입력은 버림하지 않는다', () => {
  test('swap 사용이 4KiB뿐이어도 0이 아니고 압박으로 판단된다', async () => {
    const src = fake({ ...FILES, '/proc/meminfo': meminfo(8 * 1048576, 6 * 1048576, 2 * 1048576, 2 * 1048576 - 4) });
    const r = await sampleResources(src);
    expect(r.swapUsedGB).toBeGreaterThan(0);
    expect(memoryPressure(r.memFreeGB, r.swapUsedGB, 4)).toBe(true);
  });

  test('세션 평균 메모리는 정밀도를 지킨다 — 0이나 작게 잘린 값을 보내지 않는다', () => {
    const tiny = new SessionMemory();
    tiny.record(0.001);
    expect(tiny.report()).toEqual({ perSessionGB: 0.001, samples: 1 });
    const m = new SessionMemory();
    m.record(1.009);
    expect(m.report().perSessionGB).toBe(1.009);
  });
});

describe('CpuMeter — /proc/stat 두 번 사이의 사용률', () => {
  test('첫 측정은 0, 이후 구간 사용률(%)', () => {
    const m = new CpuMeter();
    expect(m.sample('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 1 1 1\n')).toBe(0);
    // busy +150, idle +50 → 75%
    expect(m.sample('cpu  200 0 150 850 0 0 0 0 0 0\n')).toBe(75);
    // 변화 없음 → 0
    expect(m.sample('cpu  200 0 150 850 0 0 0 0 0 0\n')).toBe(0);
  });
  test('iowait도 유휴로 센다', () => {
    const m = new CpuMeter();
    m.sample('cpu  0 0 0 0 0 0 0 0\n');
    expect(m.sample('cpu  10 0 0 0 30 0 0 0\n')).toBe(25);
  });
});

describe('SessionMemory', () => {
  test('0 이하·NaN은 버린다', () => {
    const m = new SessionMemory();
    m.record(0);
    m.record(Number.NaN);
    expect(m.report()).toEqual({});
  });
});

describe('nodeHostSources — 이 PC에서 읽기만 한다', () => {
  test('실제 /proc에서 계약 형식 값이 나온다', async () => {
    const body = await collectHost(nodeHostSources(), process.cwd());
    expect(body.cores).toBeGreaterThan(0);
    expect(body.memGB).toBeGreaterThan(0);
    expect(body.hostId).toMatch(/-[0-9a-f]{16}$/);
    expect(body.bootId.length).toBeGreaterThan(0);
  });
});
