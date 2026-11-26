import { GitHubError, type GitHubClient } from '../github/client.ts';
import { normalizeRepoUrl } from '../git/identity.ts';
import type { GitRepository, SystemSsh } from '../git/repository.ts';

/** 초기화 대상 경로(contracts §6 초기화 3단계). 이 셋만 기준 커밋으로 되돌린다. */
const TARGETS = ['src', 'contracts', '.agentwbs'] as const;

/**
 * 초기화의 원격 쓰기(contracts §6). 정리 처리기는 반드시 이 순서로 부른다.
 * 1. `closePullRequests` — 기록된 PR 닫기
 * 2. `deleteBranches` — 이 시스템이 기록한 원격 Agent 브랜치만 삭제
 * 3. `pushReset` — 되돌림 커밋 일반 push(강제 push 없음)
 * 왜 이 순서인가: 되돌림을 먼저 보내면 열린 PR·브랜치가 새 main과 비교되어 잘못된 검사·병합 대상이 될 수 있다.
 */
export interface RemoteCleanup {
  /** 이 실행기가 쓰는 GitHub 저장소 주소(`https://github.com/<owner>/<repo>`). */
  readonly repository: string;
  /** 모든 메서드의 첫 인자 `target`은 정리 명령의 `repoUrl`이다. 정규화해서 `repository`와 다르면 아무것도 하지 않고 던진다. */
  closePullRequests(target: string, prs: readonly number[]): Promise<void>;
  deleteBranches(target: string, branches: readonly string[]): Promise<void>;
  /** 로컬 저장소가 없을 때: 원격 main의 초기화 대상이 기준 커밋과 같은가(쓰기 없음). 같으면 되돌림이 필요 없다. */
  targetsMatch(target: string, baseCommit: string): Promise<boolean>;
  /** 되돌림 커밋 push. 원격 main이 `parent`가 아니면 보내지 않고 실패한다. */
  pushReset(target: string, repo: GitRepository, commit: string, parent: string): Promise<void>;
}

/**
 * 정리 명령의 저장소가 등록(설정)된 저장소와 다름. 서버 DB(M1-01, migrations 0012의 repo_key 비교)와 같은 원칙을
 * Runner에서도 따로 지킨다(이중 방어): **정규화한 repoUrl이 같을 때만** 원격에 쓴다.
 * 왜: PR 번호와 브랜치 이름은 저장소마다 겹친다. 다른 저장소의 명령으로 현재 저장소의 PR·브랜치를 지우면 안 된다(재리뷰 N1).
 */
export class RepositoryMismatch extends Error {
  override name = 'RepositoryMismatch';
  constructor() { super('정리 명령의 저장소가 이 Runner에 등록된 GitHub 저장소와 다름 — 원격에 아무것도 쓰지 않았습니다.'); }
}

export function sameRepository(a: string, b: string): boolean {
  return normalizeRepoUrl(a) === normalizeRepoUrl(b);
}

export class SystemCredentialMissing extends Error {
  override name = 'SystemCredentialMissing';
  constructor() { super('되돌림 push에 쓸 시스템 SSH 키 설정이 없음 — 되돌림이 필요한 초기화는 완료할 수 없습니다.'); }
}

export interface GithubRemoteCleanupOptions {
  client: GitHubClient;
  /** owner 결정 10: 개인키는 전용 ssh-agent에 두고 공개 설정만 전달한다. */
  systemDeployKey?: SystemSsh & { id: number };
  warn?: (message: string) => void;
}

/** M4-04 GitHub 클라이언트로 만든 원격 정리. PR 닫기·브랜치 삭제는 일반 GitHub 토큰으로 한다. */
export function createGithubRemoteCleanup({ client, systemDeployKey, warn }: GithubRemoteCleanupOptions): RemoteCleanup {
  const repository = `https://github.com/${client.repo.owner}/${client.repo.repo}`;
  const guard = (target: string) => { if (!sameRepository(target, repository)) throw new RepositoryMismatch(); };
  return {
    repository,
    async closePullRequests(target, prs) {
      guard(target);
      for (const pr of prs) {
        let state: 'open' | 'closed';
        try {
          state = (await client.getPullRequest(pr)).state;
        } catch (error) {
          // 이미 지워진 PR은 닫을 것이 없다.
          if (error instanceof GitHubError && error.status === 404) continue;
          throw error;
        }
        if (state === 'open') await client.closePullRequest(pr);
      }
    },
    async deleteBranches(target, branches) {
      guard(target);
      for (const branch of branches) await client.deleteBranch(branch);
    },
    async targetsMatch(target, baseCommit) {
      guard(target);
      const main = await client.mainSha();
      if (main === null) return false;
      const [now, base] = await Promise.all([client.topLevelEntries(main), client.topLevelEntries(baseCommit)]);
      return TARGETS.every((name) => now[name] === base[name]);
    },
    async pushReset(target, repo, commit, parent) {
      guard(target);
      if (!systemDeployKey) throw new SystemCredentialMissing();
      const main = await client.mainSha();
      if (main !== parent) throw new Error('원격 main이 되돌림 커밋의 부모와 다름 — 최신 main으로 다시 초기화합니다.');
      try {
        await client.assertDeployKeys(systemDeployKey.id);
      } catch (error) {
        try { warn?.(error instanceof Error ? error.message : '시스템 deploy key 확인 실패'); }
        catch { /* 경고 출력 실패가 원래 거부 사유를 가리지 않게 한다. */ }
        throw error;
      }
      await repo.pushSystemCommit(commit, parent, systemDeployKey);
    },
  };
}
