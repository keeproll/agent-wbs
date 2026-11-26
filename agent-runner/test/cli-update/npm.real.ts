import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, constants, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { CliUpdater } from '../../src/cli-update/manager.ts';
import { createCliRegistry } from '../../src/cli-update/registry.ts';
import type { ReadinessReport } from '../../src/readiness/checks.ts';

/** npm과 실제 전역 CLI가 바뀌지 않았는지 설치 전후의 실행 파일·내용·수정 시각을 대조한다. */
async function globalFiles() {
  const files = [];
  for (const name of ['npm', 'codex', 'claude']) {
    let executable: string | undefined;
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      const path = join(directory, name);
      if (await access(path, constants.X_OK).then(() => true, () => false)) { executable = path; break; }
    }
    assert.ok(executable, `${name} 실행 파일이 PATH에 필요합니다.`);
    const target = await realpath(executable);
    const info = await stat(target);
    files.push({ name, executable, target, size: info.size, mtimeMs: info.mtimeMs,
      sha256: createHash('sha256').update(await readFile(target)).digest('hex') });
  }
  return files;
}

test('실제 npm: 두 CLI의 최신 조회 → 임시 prefix 설치 → 무과금 점검 → 링크 교체', { timeout: 300_000 }, async (t) => {
  const archive = join(homedir(), '.orca/bots/agentwbs/archive/2026-11-26/M4-05');
  await mkdir(archive, { recursive: true });
  const before = await globalFiles();
  const home = await mkdtemp(join(archive, 'real-npm-'));
  try {
    const registry = createCliRegistry({ home, env: process.env });
    const versions = { Codex: await registry.latest('Codex'), Claude: await registry.latest('Claude') };
    for (const [agent, version] of Object.entries(versions)) {
      assert.match(version, /^\d+\.\d+\.\d+$/);
      t.diagnostic(`${agent} 최신 버전: ${version}`);
    }
    const reports: ReadinessReport[] = [];
    const updater = new CliUpdater({
      home, registry, owner: { hostId: 'real-test', bootId: 'real-test', runnerId: 'real-test' },
      activity: async () => [], verified: () => [],
      profiles: () => [
        { agent: 'Codex', model: '미검증-시험용', options: 'exec --json' },
        { agent: 'Claude', model: '미검증-시험용', options: '-p --output-format stream-json' },
      ],
      report: async (report) => { reports.push(report); },
    });
    await updater.recover();
    await updater.check();
    await updater.applyPending();
    for (const agent of ['Codex', 'Claude'] as const) {
      const base = join(home, 'cli', agent.toLowerCase());
      assert.equal(await readlink(join(base, 'current')), versions[agent]);
      assert.deepEqual(JSON.parse(await readFile(join(base, 'update.json'), 'utf8')), { update_pending: null });
      await registry.probe(agent, versions[agent], join(base, 'current/bin', agent.toLowerCase()));
      t.diagnostic(`${agent} ${versions[agent]} 전용 설치·교체 뒤 점검 성공`);
    }
    assert.deepEqual(reports.at(-1)?.items.map(({ key, status }) => ({ key, status })), [
      { key: 'codex', status: 'ok' }, { key: 'claude', status: 'ok' }, { key: 'obs', status: 'warn' },
    ]);
    assert.equal(reports.at(-1)?.cli?.length, 2);
    t.diagnostic('준비 상태: Codex 정상·Claude 정상·관측 미검증; 유료 호출 0회');
  } finally {
    try {
      assert.deepEqual(await globalFiles(), before, '사용 중인 전역 실행 파일을 바꾸면 안 됩니다.');
      t.diagnostic('전역 npm·Codex·Claude의 경로·SHA-256·크기·수정 시각 보존 확인');
    } finally { await rm(home, { recursive: true, force: true }); }
    t.diagnostic('실제 설치에 쓴 전용 임시 폴더 삭제 완료');
  }
});
