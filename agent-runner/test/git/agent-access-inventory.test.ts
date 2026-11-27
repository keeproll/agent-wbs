// 조정자 결정 6 · 방어 점검 §12: Runner 계정이 Agent 작업 폴더(전용 계정이 쓸 수 있음)에 하는 git·파일 접근의 전수 목록.
// 소스에서 접근 지점을 찾아 아래 목록과 비교한다. 새 접근이 생기거나 없어지면 실패한다 → 목록과 보고서를 함께 고친다.
// git 호출 자체는 실행 시험(agent-boundary.test.ts 「전수 목록」)과 실행 가드(assertRunnerGit)가 따로 지킨다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

const src = join(import.meta.dirname, '..', '..', 'src');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') && !path.includes('/generated/') ? [path] : [];
  });
}

/** repository.ts에서 Agent 작업 폴더 모음(this.worktrees)을 쓰는 메서드와 그 접근. */
const REPOSITORY_METHODS: Record<string, string> = {
  constructor: '경로 계산 + 실행 가드 등록(protectedAreas)',
  prepare: '모음 폴더 mkdir·chmod 0710(Runner 소유)',
  createWorktree: '준비 폴더(.prep-*, 0700)에서 clone·remote remove·checkout·groupWritable → chmod 0770 → rename. 넘긴 뒤 git 없음',
  importWorktree: '전용 계정: Agent git bundle → Runner bare에서 verify·fetch / 같은 계정 배치만 fetch',
  removeWorktree: 'removeTree(GNU chmod -R·rm -rf --one-file-system) + 실패 시 래퍼 fix-perms',
  beginReset: 'readdir(이름만) + 남은 .prep-* 삭제(removeTree)',
  endReset: 'readdir(이름만, 남은 항목 세기)',
  reset: '기록된 작업 폴더마다 removeWorktree',
  taskCheckPath: '전용 계정: safePath(lstat) + Agent git inspect / 같은 계정 배치만 Runner git rev-parse·diff',
};

/** repository.ts 밖에서 Agent 작업 폴더 안 경로를 만드는(join(cwd, …)) 곳. */
const OTHER_SITES: Record<string, string> = {
  'ci/collect-tests.ts': 'package.json 읽기(O_NOFOLLOW·O_NONBLOCK·일반 파일·1 MiB)',
  'cli/dedicated-user.ts': 'ci-run --home 경로 문자열만(파일 접근 없음, 래퍼가 Agent 계정으로 확인)',
  'exec/install.ts': '같은 계정 배치(localAgentFiles)만 직접 fs. 전용 계정 배치는 래퍼 agent-file(Agent 계정)로만(fix2 추가)',
};

test('repository.ts: Agent 작업 폴더 모음을 쓰는 메서드는 목록의 것뿐이다', () => {
  const text = readFileSync(join(src, 'git', 'repository.ts'), 'utf8');
  const methods = [...text.matchAll(/\n {2}(?:(?:private|static|readonly) )*(?:async )?([A-Za-z]+)\([^)]*\)[^{;]*\{/g)].map((m) => ({ at: m.index, name: m[1] ?? '' }));
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:this|repo)\.worktrees/g)) {
    const owner = methods.filter((x) => x.at < (m.index)).at(-1)?.name;
    if (owner) found.add(owner);
  }
  expect([...found].sort()).toEqual(Object.keys(REPOSITORY_METHODS).sort());
});

test('repository.ts 밖에서 작업 폴더 안 경로를 만드는 곳은 목록의 것뿐이다', () => {
  const found = files(src).filter((path) => !path.endsWith('git/repository.ts') && /join\(cwd, /.test(readFileSync(path, 'utf8'))).map((path) => relative(src, path));
  expect(found.sort()).toEqual(Object.keys(OTHER_SITES).sort());
});

test('Runner git이 Agent .git을 저장소로 쓰는 모양(--git-dir=·Agent 경로 fetch)은 같은 계정 배치 갈래에만 남는다', () => {
  const text = readFileSync(join(src, 'git', 'repository.ts'), 'utf8');
  // taskCheckPath의 같은 계정 갈래(rev-parse, --work-tree diff·ls-files)와 importWorktree의 같은 계정 fetch.
  expect(text.match(/--git-dir=\$\{join\(path, '\.git'\)\}/g)).toHaveLength(1);
  expect(text.match(/--work-tree=\$\{path\}/g)).toHaveLength(2);
  expect(text.match(/'--upload-pack=git-upload-pack', '--', join\(path, '\.git'\)/g)).toHaveLength(1);
  // 그 갈래는 모두 「this.agentGit이 없을 때」(같은 계정 배치) 뒤에 있다.
  const shared = text.slice(text.indexOf('async taskCheckPath'), text.indexOf('async reset('));
  expect(shared.indexOf('if (this.agentGit)')).toBeLessThan(shared.indexOf('--git-dir='));
});

test('exec/install.ts: 직접 파일 접근은 같은 계정 배치용(localAgentFiles·directory)에만 있고, 설치 본문은 AgentFiles만 쓴다', () => {
  const text = readFileSync(join(src, 'exec', 'install.ts'), 'utf8');
  const body = text.slice(text.indexOf('export async function installSubagents'));
  for (const call of ['readFile(', 'atomicWrite(', 'rm(', 'mkdir(', 'lstat(', 'writeFile(', 'open(']) expect(body, call).not.toContain(call);
  const local = text.slice(text.indexOf('export const localAgentFiles'), text.indexOf('export async function installSubagents'));
  expect(local).toContain("kind: 'same-account'");
});

test('Execution은 전용 계정 배치에서 Agent 계정 파일 접근을 받는다(app.ts 연결)', () => {
  const text = readFileSync(join(src, 'app.ts'), 'utf8');
  expect(text).toContain('...(d.agentRoot && { agentFiles: wrapperAgentFiles() }),');
});
