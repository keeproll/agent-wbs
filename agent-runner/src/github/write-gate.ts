import { randomUUID } from 'node:crypto';
import type { ApiClient } from '../api/client.ts';
import { normalizeRepoUrl } from '../git/identity.ts';
import { LEASE_SAFETY_MS } from '../exec/session.ts';
import type { PushGate } from '../git/repository.ts';
import { GitHubError, type GitHubClient, type WriteOperation } from './client.ts';

/*
 * Runner의 모든 외부 쓰기는 같은 관문 하나를 지난다(M5·M7 통합 조정자 판단).
 * 관문 = ① 소유 확인(중단 신호·서버 임대) → ② M4 쓰기 관문(`beforeWrite`: 원격 저장소 확인 → 배포 키 검사).
 * - GitHub REST 쓰기: 클라이언트 메서드 안에서 ②를 부른다. job 안에서는 `ownedGitHub`로 ①을 앞에 붙인다.
 * - Git push: `GitRepository`의 push 메서드가 관문(`PushGate`)을 필수 인자로 받아 push 직전에 부른다. `pushGate`가 ①→②→①을 만든다.
 * 외부 쓰기 함수와 그 호출 위치의 목록은 아래 상수에 있다. `test/external-writes.test.ts`가 소스와 대조한다.
 */

/** GitHub 클라이언트의 REST 쓰기 메서드(각 메서드는 안에서 `beforeWrite`를 부른다). */
export const REST_WRITES = ['ensurePullRequest', 'closePullRequest', 'deleteBranch', 'setCommitStatus', 'mergePullRequest'] as const;
/** GitRepository의 Git 쓰기 메서드(각 메서드는 push 직전에 `gate`를 부른다). */
export const GIT_WRITES = ['pushCommit', 'pushSystemCommit'] as const;
/**
 * 외부 쓰기 함수를 부르는 제품 파일과 소유 확인 방식. 새 호출 위치를 만들면 시험이 실패한다. 여기에 이유와 함께 등록한다.
 */
export const WRITE_CALLERS: Readonly<Record<string, string>> = {
  'src/jobs/task-check.ts': '시도(attempt) job: serverWriteGuard(중단·임대) → pushGate·PR 생성',
  'src/ci/integration/queue.ts': '통합(integrate) job: 의존성 guard(CiJobs가 serverWriteGuard) → pushGate·ownedGitHub(상태·병합)',
  'src/cleanup/remote.ts': '초기화 정리 명령: job 임대가 없다(서버 초기화 세대로 묶임). M4 관문(원격·배포 키)만',
};

/** 외부 쓰기 직전에 이 작업을 아직 맡고 있는지 확인한다. 아니면 던진다(쓰지 않는다). */
export type OwnershipGuard = () => Promise<void>;
const noGuard: OwnershipGuard = () => Promise.resolve();

/**
 * 서버 기준 소유 확인. 임대 연장(renewJob)은 서버가 fence·임대·Runner를 대조해 맞을 때만 성공한다(아니면 409 LEASE_LOST).
 * 연장된 임대가 시계 역행 여유(LEASE_SAFETY_MS)보다 짧게 남았어도 쓰지 않는다.
 * 왜: 로컬 중단 신호만으로는 서버가 이미 다른 Runner에 넘긴 job을 알 수 없다. 낡은 실행이 원격을 바꾸면 되돌릴 수 없다.
 */
export function serverWriteGuard(api: ApiClient, job: { id: string; fence: number }, epoch: number, signal?: AbortSignal): OwnershipGuard {
  return async () => {
    signal?.throwIfAborted();
    const renewed = await api('renewJob', { epoch, idempotencyKey: randomUUID(), params: { id: job.id }, body: { fence: job.fence } });
    signal?.throwIfAborted();
    if (!(Date.parse(renewed.body.leaseUntil) - LEASE_SAFETY_MS > Date.now())) throw new Error('임대가 곧 끝나 외부 쓰기를 시작하지 않습니다.');
  };
}

/** Git push용 관문: 소유 확인 → M4 쓰기 관문 → 소유 확인(관문 검사 중 임대를 잃었을 수 있다). */
export function pushGate(github: Pick<GitHubClient, 'assertWritable'>, guard: OwnershipGuard = noGuard): PushGate {
  return async (operation) => {
    await guard();
    await github.assertWritable(operation);
    await guard();
  };
}

type RestWrite = (typeof REST_WRITES)[number];
/** REST 쓰기 메서드 앞에 소유 확인을 붙인 클라이언트 보기. 읽기 메서드와 M4 관문(클라이언트 안의 beforeWrite)은 그대로다. */
export function ownedGitHub<T extends Partial<Pick<GitHubClient, RestWrite>>>(github: T, guard: OwnershipGuard): T {
  const owned: Record<string, unknown> = { ...github };
  for (const name of REST_WRITES) {
    const method = github[name] as ((...args: never[]) => Promise<unknown>) | undefined;
    if (method) owned[name] = async (...args: never[]) => { await guard(); return method.apply(github, args); };
  }
  return owned as T;
}

/**
 * 앱이 GitHub 클라이언트의 `beforeWrite`에 거는 쓰기 관문(M4). 모든 외부 쓰기(REST·Git push)가 같은 함수를 지난다.
 * - Git push(`branch_push`): push할 원격이 설정한 GitHub 저장소인지 먼저 확인한다.
 * - 그다음 배포 키 검사(승인하지 않은 deploy key가 있거나 목록을 확인할 수 없으면 거부)를 한다.
 * 왜: 원격이나 키를 확인할 수 없으면 쓰기를 중단한다는 M4 규칙을 push에도 똑같이 적용하기 위해서다.
 */
export function githubWriteGate(repository: string, checkDeployKeys: () => Promise<void>): (operation: WriteOperation) => Promise<void> {
  return async (operation) => {
    if (operation.kind === 'branch_push' && normalizeRepoUrl(operation.remote) !== normalizeRepoUrl(repository)) {
      throw new GitHubError('push할 원격이 GitHub 설정의 저장소와 다릅니다. 쓰기를 중단합니다.', -1, false);
    }
    await checkDeployKeys();
  };
}
