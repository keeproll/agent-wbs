import { GitHubError, type GitHubClient } from '../github/client.ts';
import type { GitRepository } from '../git/repository.ts';

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
  closePullRequests(prs: readonly number[]): Promise<void>;
  deleteBranches(branches: readonly string[]): Promise<void>;
  /** 로컬 저장소가 없을 때: 원격 main의 초기화 대상이 기준 커밋과 같은가(쓰기 없음). 같으면 되돌림이 필요 없다. */
  targetsMatch(baseCommit: string): Promise<boolean>;
  /** 되돌림 커밋 push. 원격 main이 `parent`가 아니면 보내지 않고 실패한다. */
  pushReset(repo: GitRepository, commit: string, parent: string): Promise<void>;
}

export class SystemCredentialMissing extends Error {
  override name = 'SystemCredentialMissing';
  constructor() { super('되돌림 push에 쓸 시스템 커밋 자격 증명이 없음(Q-09 미결) — 되돌림이 필요한 초기화는 완료할 수 없습니다.'); }
}

export interface GithubRemoteCleanupOptions {
  client: GitHubClient;
  /**
   * main 직접 push용 **시스템 커밋 자격 증명**(contracts §6 「별도 시스템 커밋 자격 증명 — Q-09」).
   * `Authorization` 헤더 값(예: `Bearer …`)을 돌려준다. 없거나 null이면 되돌림 push를 하지 않는다.
   * 왜 일반 GitHub 토큰을 쓰지 않나: 계약이 main 직접 push를 별도 자격 증명으로만 허용한다(조정자 결정 1-A).
   */
  systemCommitAuthorization?: () => Promise<string | null>;
}

/** M4-04 GitHub 클라이언트로 만든 원격 정리. PR 닫기·브랜치 삭제는 일반 GitHub 토큰으로 한다. */
export function createGithubRemoteCleanup({ client, systemCommitAuthorization }: GithubRemoteCleanupOptions): RemoteCleanup {
  return {
    async closePullRequests(prs) {
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
    async deleteBranches(branches) {
      for (const branch of branches) await client.deleteBranch(branch);
    },
    async targetsMatch(baseCommit) {
      const main = await client.mainSha();
      if (main === null) return false;
      const [now, base] = await Promise.all([client.topLevelEntries(main), client.topLevelEntries(baseCommit)]);
      return TARGETS.every((name) => now[name] === base[name]);
    },
    async pushReset(repo, commit, parent) {
      const authorization = (await systemCommitAuthorization?.()) ?? null;
      if (authorization === null) throw new SystemCredentialMissing();
      const main = await client.mainSha();
      if (main !== parent) throw new Error('원격 main이 되돌림 커밋의 부모와 다름 — 최신 main으로 다시 초기화합니다.');
      await repo.pushCommit(commit, 'main', authorization);
    },
  };
}
