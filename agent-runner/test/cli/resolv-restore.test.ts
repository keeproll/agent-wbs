import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';

/**
 * 부팅 복구 도우미(scripts/isolation/awbs-resolv-restore.sh, fix9)를 실제 bash로 돌린다. 실제 /etc는 건드리지 않는다.
 * - 경로와 「사본 소유자 UID」만 시험 폴더·시험 계정으로 바꾼 사본을 쓴다.
 * - 상황: 설치~WSL 재시작 사이에 WSL이 /etc/resolv.conf를 링크로 다시 만들어 굳었다(리뷰8 P2-1).
 */
const uid = process.getuid?.() ?? -1;
const usable = uid > 0;
const base = realpathSync(mkdtempSync(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'awbs-restore-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const original = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'isolation', 'awbs-resolv-restore.sh'), 'utf8');
const FILE_MARK = original.match(/\nFILE_MARK='([^']+)'/)?.[1] ?? '';

let D = '';
let n = 0;
let dst = '';
let mode = '';
let saved = '';
let script = '';

function make(ownerUid = uid): void {
  D = join(base, `t${++n}`);
  mkdirSync(join(D, 'etc/agentwbs'), { recursive: true });
  mkdirSync(join(D, 'mnt/wsl'), { recursive: true });
  dst = join(D, 'etc/resolv.conf');
  mode = join(D, 'etc/agentwbs/dns-mode');
  saved = join(D, 'etc/agentwbs/resolv.conf.installed');
  const swaps: [string, string][] = [
    ['\nDST=/etc/resolv.conf\n', `\nDST=${dst}\n`],
    ['\nMODE_RECORD=/etc/agentwbs/dns-mode\n', `\nMODE_RECORD=${mode}\n`],
    ['\nSAVED=/etc/agentwbs/resolv.conf.installed\n', `\nSAVED=${saved}\n`],
    ['\nOWNER_UID=0\n', `\nOWNER_UID=${ownerUid}\n`],
  ];
  let body = original;
  for (const [from, to] of swaps) {
    expect(body).toContain(from);
    body = body.replace(from, to);
  }
  script = join(D, 'restore.sh');
  writeFileSync(script, body);
}
const restore = () => {
  const r = spawnSync('bash', [script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
/** 링크가 굳은 상태: /etc/resolv.conf → (없는) /mnt/wsl/resolv.conf */
const frozenLink = () => symlinkSync(join(D, 'mnt/wsl/resolv.conf'), dst);

describe.skipIf(!usable)('awbs-resolv-restore: 부팅 때 링크를 저장 사본으로 되살림(fix9)', () => {
  beforeEach(() => make());

  test('표시 줄 상수가 common.sh·도우미와 같다', () => {
    const common = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'isolation', 'common.sh'), 'utf8');
    expect(FILE_MARK).toContain('터널링');
    expect(common).toContain(`RESOLV_FILE_MARK='${FILE_MARK}'`);
  });

  test('tunnel + 끊긴 링크 + 저장 사본 → 저장 사본 내용의 실제 파일(0644)', () => {
    writeFileSync(mode, 'tunnel\n');
    writeFileSync(saved, `${FILE_MARK}\nnameserver 10.255.255.254\nsearch kornet\n`);
    frozenLink();
    const r = restore();
    expect(r.code, r.out).toBe(0);
    expect(lstatSync(dst).isSymbolicLink()).toBe(false);
    expect(readFileSync(dst, 'utf8')).toBe(`${FILE_MARK}\nnameserver 10.255.255.254\nsearch kornet\n`);
    expect(lstatSync(dst).mode & 0o777).toBe(0o644);
  });

  test('저장 사본이 없으면 고정 주소 한 줄로', () => {
    writeFileSync(mode, 'tunnel\n');
    frozenLink();
    expect(restore().code).toBe(0);
    expect(readFileSync(dst, 'utf8')).toBe(`${FILE_MARK}\nnameserver 10.255.255.254\n`);
  });

  test('저장 사본이 다른 주소·표시 없음·링크·다른 소유자면 믿지 않고 고정 주소 한 줄로', () => {
    for (const plant of [
      () => writeFileSync(saved, `${FILE_MARK}\nnameserver 6.6.6.6\n`),
      () => writeFileSync(saved, 'nameserver 10.255.255.254\n'),
      () => { writeFileSync(join(D, 'other'), `${FILE_MARK}\nnameserver 10.255.255.254\nsearch evil\n`); symlinkSync(join(D, 'other'), saved); },
    ]) {
      make();
      writeFileSync(mode, 'tunnel\n');
      plant();
      frozenLink();
      expect(restore().code).toBe(0);
      expect(readFileSync(dst, 'utf8')).toBe(`${FILE_MARK}\nnameserver 10.255.255.254\n`);
    }
    make(0);
    writeFileSync(mode, 'tunnel\n');
    writeFileSync(saved, `${FILE_MARK}\nnameserver 10.255.255.254\nsearch mine\n`);
    frozenLink();
    expect(restore().code).toBe(0);
    expect(readFileSync(dst, 'utf8')).toBe(`${FILE_MARK}\nnameserver 10.255.255.254\n`);
  });

  test('터널링 방식이 아니면(기록 없음·sync) 링크여도 아무것도 하지 않는다', () => {
    frozenLink();
    expect(restore().code).toBe(0);
    expect(lstatSync(dst).isSymbolicLink()).toBe(true);
    writeFileSync(mode, 'sync\n');
    expect(restore().out).toContain('터널링 방식이 아니라');
    expect(readlinkSync(dst)).toBe(join(D, 'mnt/wsl/resolv.conf'));
  });

  test('/etc/resolv.conf가 이미 실제 파일이면(정상이거나 owner가 관리) 건드리지 않는다', () => {
    writeFileSync(mode, 'tunnel\n');
    writeFileSync(dst, 'nameserver 1.1.1.1\n');
    const r = restore();
    expect(r.code).toBe(0);
    expect(readFileSync(dst, 'utf8')).toBe('nameserver 1.1.1.1\n');
  });
});
