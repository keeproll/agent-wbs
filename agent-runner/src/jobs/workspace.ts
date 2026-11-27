import { createHash } from 'node:crypto';
import type { GitRepository } from '../git/repository.ts';
import type { AttemptJob } from '../exec/session.ts';
import { outputGuide } from './output.ts';

/*
 * 시도별 작업 폴더 준비(execution.prepare)와 재사용·정리 규칙. README 「작업 폴더 규칙」과 같은 내용이다.
 *
 * 폴더는 Task 브랜치(job.payload.branch)마다 두 개다.
 * - 개발 폴더(`w-<브랜치 hash>-dev`): dev·rework가 쓴다. 재시도·재작업은 같은 폴더를 다시 쓴다.
 *   왜: CLI 세션 재개(resume)는 같은 cwd일 때만 이어진다(`Execution`이 비교한다). 중단된 작업의 파일도 그대로 남아야 한다.
 * - 검증 폴더(`w-<브랜치 hash>-qa`): qa·reverify가 쓴다. 매번 지우고 ①이 검사한 커밋으로 새로 만든다.
 *   왜: QA는 읽기 전용 상태(검사한 코드 그대로)에서 시작해야 한다(contracts §4.1 「코드 근거 고정」 1).
 *   경로가 같으므로 같은 Task의 재검증도 CLI 세션을 이어 갈 수 있다.
 * 브랜치 hash를 쓰는 이유: 초기화 세대가 바뀌면 브랜치 이름도 바뀌어(taskBranch) 옛 세대 폴더와 섞이지 않는다.
 *
 * 폴더 만들기는 모두 `GitRepository.createWorktree`가 한다. 전용 계정 배치는 Runner 전용 준비 폴더(`.prep-<uuid>`, 0700)에서
 * clone → remote remove → checkout을 끝낸 뒤 0770으로 바꿔 제자리로 옮긴다(조정자 결정 6). 그 뒤 Runner git은 그 폴더에서 돌지 않는다.
 * 하위 Agent 정의 파일은 `Execution`이 이 준비 뒤에 래퍼 `agent-file`(Agent 계정)로 넣는다.
 */

export interface WorkspaceOptions {
  /** 앱의 로컬 clone. 아직 없으면(초기 분석 전) 예외를 던진다. 처음 부를 때 연다. */
  repo: () => Promise<GitRepository>;
  /**
   * 시험 전용. 작업 폴더를 만들 때 실행마다 새 HOME(`.awbs-home`)도 만든다(검사 사본과 같은 방법).
   * 왜: host 시험의 fake CLI는 래퍼 `ci-run`으로 띄우는데, `ci-run`은 작업 폴더 안의 `.awbs-home`을 요구한다. 실제 CLI(`run`)는 쓰지 않는다.
   */
  sessionHome?: boolean;
}

export interface AttemptWorkspace {
  prepare(job: AttemptJob): Promise<{ cwd: string; headSha: string; notes: string }>;
  /** ① 공급원(`TaskCheckSources.worktree`): 개발 폴더의 등록 이름과 로컬 Agent 브랜치. */
  worktree(job: AttemptJob): { id: string; branch: string };
  /** 검증 폴더의 등록 이름. */
  verifyWorktree(job: AttemptJob): string;
  /**
   * 결과 보고가 서버에 받아들여진 뒤의 정리.
   * - qa·reverify: 검증 폴더를 지운다. PASS면 개발 폴더도 지운다(다음 재작업은 원격 Task 브랜치에서 다시 만든다).
   * - dev·rework: 지우지 않는다(QA FAIL 뒤 재작업이 같은 폴더를 쓴다).
   */
  settle(job: AttemptJob, verdict: 'PASS' | 'FAIL' | 'BLOCKED' | null): Promise<void>;
  /**
   * Task가 끝났을 때(병합 확인 → done) 그 Task 브랜치의 개발·검증 폴더를 모두 지운다. 없으면 아무것도 하지 않는다.
   * 왜: QA PASS 뒤 정리가 실패했거나, 병합 전 재작업으로 다시 만든 폴더가 남으면 디스크와 생성 기록이 쌓인다.
   */
  release(branch: string): Promise<void>;
}

const role = (job: AttemptJob) => job.payload.kind === 'dev' || job.payload.kind === 'rework' ? 'dev' : 'qa';
const keyOf = (branch: string) => createHash('sha256').update(branch).digest('hex').slice(0, 20);
const key = (job: AttemptJob) => keyOf(job.payload.branch);

export function createWorkspace(options: WorkspaceOptions): AttemptWorkspace {
  let opened: Promise<GitRepository> | undefined;
  const repo = async () => {
    opened ??= options.repo();
    try { return await opened; } catch (error) { opened = undefined; throw error; }
  };
  const devId = (job: AttemptJob) => `w-${key(job)}-dev`;
  const qaId = (job: AttemptJob) => `w-${key(job)}-qa`;
  const branchOf = (id: string) => `agent/${id}`;
  const create = async (git: GitRepository, id: string, commit: string, evidence = false) =>
    git.createWorktree(id, branchOf(id), commit, { ...(options.sessionHome && { ciHome: true }), ...(evidence && { evidence: true }) });

  /** 입력 사본(고정 커밋의 `prototype/`, 읽기 전용). 이미 있으면 다시 쓴다. `prototype/`이 없는 커밋이면 null. */
  const input = async (git: GitRepository, job: AttemptJob): Promise<string | null> => {
    const name = `in-v${String(job.payload.inputVersion)}-${job.payload.baseCommit.slice(0, 12)}`;
    const existing = await git.inputPath(name);
    if (existing) return existing;
    if ((await git.listFiles(job.payload.baseCommit, 'prototype/')).length === 0) return null;
    try { return await git.checkoutInput(name, job.payload.baseCommit); }
    catch (error) {
      // 같은 입력을 다른 시도가 방금 만들었으면 그것을 쓴다. 그 밖의 실패는 그대로 알린다.
      const raced = await git.inputPath(name);
      if (raced) return raced;
      throw error;
    }
  };

  return {
    worktree: job => ({ id: devId(job), branch: branchOf(devId(job)) }),
    verifyWorktree: qaId,
    async prepare(job) {
      const git = await repo();
      let cwd: string, headSha: string;
      if (role(job) === 'dev') {
        const id = devId(job);
        let state = await git.worktreeState(id);
        if (state.kind === 'missing') { await git.removeWorktree(id); state = { kind: 'none' }; }
        if (state.kind === 'ready') {
          // 재시도·재작업: 같은 폴더를 그대로 쓴다. 커밋하지 않은 파일도 지우지 않는다(중단된 작업을 이어 간다).
          cwd = state.path;
        } else {
          // 새 폴더. 재작업이면 QA가 본 커밋(원격 Task 브랜치)에서 이어 간다. 못 읽으면 추측하지 않고 실패한다.
          const start = job.payload.kind === 'rework' ? await git.resultHead(id) ?? await git.fetchBranch(job.payload.branch) : job.payload.baseCommit;
          // 서버가 준 입력 커밋을 아직 받지 않았으면 원격 main을 받는다. 그래도 없으면 createWorktree가 실패한다(추측하지 않음).
          if (!await git.hasCommit(start)) await git.fetch();
          cwd = await create(git, id, start);
        }
        headSha = await git.worktreeHead(id);
      } else {
        // 검증: ①이 검사해 가져온 결과 커밋(로컬 기록) → 없으면 원격 Task 브랜치(①을 통과한 커밋만 push된다).
        const id = qaId(job);
        headSha = await git.resultHead(devId(job)) ?? await git.fetchBranch(job.payload.branch);
        if ((await git.worktreeState(id)).kind !== 'none') await git.removeWorktree(id);
        // 증거 폴더(.awbs-evidence)도 만든다. 상태 검사에서 빠지므로 QA가 증거를 남겨도 청결 확인을 통과한다.
        cwd = await create(git, id, headSha, true);
      }
      if (!await git.hasCommit(job.payload.baseCommit)) await git.fetch();
      const inputPath = await input(git, job);
      return { cwd, headSha, notes: outputGuide(job, inputPath) };
    },
    async release(branch) {
      const git = await repo();
      for (const id of [`w-${keyOf(branch)}-qa`, `w-${keyOf(branch)}-dev`]) {
        if ((await git.worktreeState(id)).kind !== 'none') await git.removeWorktree(id);
      }
    },
    async settle(job, verdict) {
      if (role(job) === 'dev') return;
      const git = await repo();
      if ((await git.worktreeState(qaId(job))).kind !== 'none') await git.removeWorktree(qaId(job));
      if (verdict === 'PASS' && (await git.worktreeState(devId(job))).kind !== 'none') await git.removeWorktree(devId(job));
    },
  };
}
