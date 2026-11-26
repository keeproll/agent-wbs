import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, expect, test } from 'vitest';
import { readStoredFile } from '../src/reset/files.ts';
import { zip } from '../src/reset/zip.ts';

const root = await mkdtemp(join(tmpdir(), 'awbs-reset-unit-'));
afterAll(() => rm(root, { recursive: true, force: true }));

test('reset zip은 한글 이름·빈 파일·바이너리의 내용을 다른 ZIP 읽기 도구에서도 보존한다', () => {
  const archive = zip([{ name: '한글/빈 파일', data: Buffer.alloc(0) }, { name: 'proof', data: Buffer.from([0, 255, 1]) }]);
  const decoded = spawnSync('python3', ['-c', 'import sys,zipfile,io,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({n:list(z.read(n)) for n in z.namelist()}))'], { input: archive, encoding: 'utf8' });
  expect(decoded.status, decoded.stderr).toBe(0);
  expect(JSON.parse(decoded.stdout)).toEqual({ '한글/빈 파일': [], proof: [0, 255, 1] });
  // M2-04 리뷰 P3-5: 「만든 OS」가 Unix(3)여야 Info-ZIP unzip도 UTF-8 이름을 그대로 푼다.
  const system = spawnSync('python3', ['-c', 'import sys,zipfile,io; print([i.create_system for i in zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).infolist()])'], { input: archive, encoding: 'utf8' });
  expect(system.stdout.trim()).toBe('[3, 3]');
  // Info-ZIP unzip이 설치된 PC에서는 실제로 이름을 확인한다(없으면 위 바이트 검사로 충분).
  if (spawnSync('unzip', ['-v']).status === 0) {
    const file = join(root, 'names.zip');
    writeFileSync(file, archive);
    expect(spawnSync('unzip', ['-Z1', file], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)).toEqual(['한글/빈 파일', 'proof']);
  }
});

test('reset export는 파일뿐 아니라 상위 폴더 링크로도 다른 세대에 접근하지 못한다', async () => {
  await mkdir(join(root, '1'), { recursive: true });
  await mkdir(join(root, '2'), { recursive: true });
  await writeFile(join(root, '2/secret'), '다른 세대');
  await symlink(join(root, '2'), join(root, '1/linked'));
  await expect(readStoredFile(root, 1, '1/linked/secret')).rejects.toThrow();
  await expect(readStoredFile(root, 1, '1/../2/secret')).rejects.toThrow();
  await expect(readStoredFile(root, 1, '2/secret')).rejects.toThrow();
});
