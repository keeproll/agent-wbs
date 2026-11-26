import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiRequest, ApiResponse } from '../api/client.ts';
import { GitCleanupError, GitRepository } from '../git/repository.ts';

type Command = ApiResponse<'getCommands'>['body']['commands'][number];
export type CommandResult = ApiRequest<'reportCommandResult'>['body'];
type HoldProof = Extract<CommandResult, { status: 'done' }>['holds'][number];
type Item = CommandResult['items'][number];

/** 정리 명령 payload의 보유 하나(data-model §5: 보유 중인 실행 목록 pgid·host·boot를 payload로 옮긴다). */
export interface PayloadHold {
  job: string;
  hostId: string | null;
  bootId: string | null;
  processGroup: number | null;
}

/**
 * `reset-cleanup` payload. 계약은 자유 형식(`Record<string, unknown>`)이라 Runner가 이 모양만 받는다 [결정].
 * - `projectId`: Runner 로컬 저장소 이름(`repos/<projectId>`).
 * - `baseCommit`: 등록 기준 커밋. null이면 저장소 정리를 생략한다(§9.5-2).
 * - `branches`: 서버가 기록한 Agent 브랜치. `agent/*` 검색 결과가 아니다.
 * - `holds`: 보유 중인 실행 목록. 모두 종료가 확인돼야 정리한다.
 */
export interface ResetPayload {
  projectId: string;
  baseCommit: string | null;
  branches: string[];
  holds: PayloadHold[];
}

export class PayloadError extends Error {
  override name = 'PayloadError';
}

const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';

export function parseResetPayload(payload: Record<string, unknown>): ResetPayload {
  const { projectId, baseCommit, branches, holds } = payload;
  if (!isText(projectId) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(projectId)) throw new PayloadError('projectId가 올바르지 않습니다.');
  if (baseCommit !== null && (typeof baseCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit))) throw new PayloadError('baseCommit은 전체 SHA 또는 null이어야 합니다.');
  if (!Array.isArray(branches) || !branches.every((b) => isText(b) && b.startsWith('agent/'))) throw new PayloadError('branches는 agent/ 브랜치 목록이어야 합니다.');
  if (!Array.isArray(holds)) throw new PayloadError('holds 목록이 없습니다.');
  const parsed = holds.map((h: unknown): PayloadHold => {
    if (!h || typeof h !== 'object') throw new PayloadError('보유 항목 형식이 올바르지 않습니다.');
    const { job, hostId, bootId, processGroup } = h as Record<string, unknown>;
    if (!isText(job)) throw new PayloadError('보유 항목에 job이 없습니다.');
    if (hostId !== null && !isText(hostId)) throw new PayloadError('보유 항목의 hostId가 올바르지 않습니다.');
    if (bootId !== null && !isText(bootId)) throw new PayloadError('보유 항목의 bootId가 올바르지 않습니다.');
    const group = processGroup ?? null;
    if (group !== null && (!Number.isSafeInteger(group) || (group as number) <= 1)) throw new PayloadError('보유 항목의 processGroup이 올바르지 않습니다.');
    return { job, hostId, bootId, processGroup: group as number | null };
  });
  return { projectId, baseCommit, branches: branches as string[], holds: parsed };
}

/** 프로세스 그룹이 비었는가. ESRCH만 「비었음」이다. EPERM(다른 사용자 소유)은 살아 있는 것으로 본다. */
export function processGroupEmpty(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** 원격 정리(M4-04 GitHub 쓰기). 외부 쓰기 권한(§3.4-5) 확인과 함께 연결한다. 없으면 원격 작업이 필요한 정리는 실패로 보고한다. */
export interface RemoteCleanup {
  /** 서버가 기록한 Agent 브랜치의 열린 PR을 닫고 원격 브랜치를 지운다. */
  removeBranches(branches: readonly string[]): Promise<void>;
  /** 되돌림 커밋을 일반 push로 보낸다. 보내기 전 GitHub의 main이 `parent`인지 대조해야 한다. */
  pushReset(repo: GitRepository, commit: string, parent: string): Promise<void>;
}

export interface ResetCleanupDeps {
  home: string;
  /** 현재 PC·부팅 식별자(host 보고와 같은 값) */
  identity: () => { hostId: string; bootId: string };
  groupEmpty?: (pgid: number) => boolean;
  /**
   * pgid가 없는 같은 부팅의 보유에 대해 launch 기록을 대조한다(contracts §3.4-3, M5-02 실행 계층이 제공).
   * `none`: 실행 명령도 래퍼도 없음을 확인. `unknown`: 확인할 수 없음 → unconfirmed 유지.
   */
  launchCheck?: (hold: PayloadHold) => Promise<'none' | 'unknown'>;
  remote?: RemoteCleanup;
}

/**
 * M4-01 `RunnerOptions.cleanup`에 넘기는 초기화 정리.
 *
 * 순서가 중요하다.
 * 1. **먼저 모든 보유의 프로세스 종료를 증명한다.** 하나라도 증명하지 못하면 파일·브랜치를 건드리지 않고 failed로 보고한다.
 *    왜: M4-03의 잠금 회수는 잠금 주인 Node만 확인한다. 하위 git·Agent 프로세스가 살아 있는데 폴더를 지우면 안 된다(M4-03 최종 확인 §3).
 * 2. 그다음 로컬 Git 정리(M4-03 `reset`): 생성 기록의 작업 폴더·입력 사본·서버가 기록한 브랜치.
 * 3. 원격 정리(PR 닫기·원격 브랜치 삭제·되돌림 커밋 push)는 `remote`가 있을 때만 한다.
 */
export function createResetCleanup(deps: ResetCleanupDeps): (command: Command) => Promise<CommandResult> {
  const groupEmpty = deps.groupEmpty ?? processGroupEmpty;
  const launchCheck = deps.launchCheck ?? (() => Promise.resolve('unknown' as const));
  return async (command) => {
    let payload: ResetPayload;
    try {
      payload = parseResetPayload(command.payload);
    } catch (error) {
      return { status: 'failed', items: [{ name: 'payload', ok: false, detail: error instanceof Error ? error.message : '정리 명령 형식 오류' }] };
    }
    const { hostId, bootId } = deps.identity();
    const items: Item[] = [];
    const proofs: HoldProof[] = [];
    for (const hold of payload.holds) {
      const name = `hold:${hold.job}`;
      if (hold.hostId === null) {
        // 예약 전 보유: 어느 PC에서도 프로세스를 만든 적이 없다.
        proofs.push({ job: hold.job, hostId: null, bootId: hold.bootId, proof: 'no_process' });
        items.push({ name, ok: true, detail: '예약 전 보유 — 실행된 프로세스 없음' });
      } else if (hold.hostId !== hostId) {
        items.push({ name, ok: false, detail: '다른 PC의 보유 — 이 PC에서는 종료를 증명할 수 없음' });
      } else if (hold.bootId !== bootId) {
        proofs.push({ job: hold.job, hostId: hold.hostId, bootId: hold.bootId, proof: 'boot_changed', processGroup: hold.processGroup, currentBootId: bootId });
        items.push({ name, ok: true, detail: '부팅이 바뀜 — 이전 프로세스는 존재할 수 없음' });
      } else if (hold.processGroup !== null) {
        if (groupEmpty(hold.processGroup)) {
          proofs.push({ job: hold.job, hostId: hold.hostId, bootId: hold.bootId, proof: 'group_empty', processGroup: hold.processGroup });
          items.push({ name, ok: true, detail: `프로세스 그룹 ${String(hold.processGroup)} 비었음` });
        } else {
          // pgid 재사용 가능성 때문에 시작 시각·launchId 대조 없이 죽이지 않는다(§3.4-3). 실행 계층(M5-02)이 종료한 뒤 다시 시도된다.
          items.push({ name, ok: false, detail: `프로세스 그룹 ${String(hold.processGroup)}이 아직 살아 있음 — 종료 확인 뒤 다시 시도` });
        }
      } else if ((await launchCheck(hold)) === 'none') {
        proofs.push({ job: hold.job, hostId: hold.hostId, bootId: hold.bootId, proof: 'no_process' });
        items.push({ name, ok: true, detail: 'launch 기록 대조 — 실행 명령·래퍼 없음' });
      } else {
        items.push({ name, ok: false, detail: 'launch 기록을 확인할 수 없음 — unconfirmed 유지' });
      }
    }
    if (proofs.length !== payload.holds.length) return { status: 'failed', items };

    const failed = (item: Item): CommandResult => ({ status: 'failed', items: [...items, item], holds: proofs });
    const repoPath = join(deps.home, 'repos', payload.projectId);
    const exists = await lstat(repoPath).then(() => true, () => false);
    if (!exists) {
      // 이 PC에 받은 적 없는 저장소는 로컬 정리할 것이 없다. 원격 정리는 여전히 필요할 수 있다.
      items.push({ name: 'git:local', ok: true, detail: '이 PC에 로컬 저장소 없음' });
    } else {
      let repo: GitRepository;
      try {
        repo = await GitRepository.open(deps.home, payload.projectId);
      } catch (error) {
        return failed({ name: 'git:open', ok: false, detail: error instanceof Error ? error.message : '저장소를 열 수 없음' });
      }
      try {
        const worktrees = await repo.recordedWorktrees();
        const inputs = await repo.inputIds();
        const { commit } = await repo.reset({ baseCommit: payload.baseCommit, branches: payload.branches, worktrees, inputs });
        items.push({ name: 'git:local', ok: true, detail: `작업 폴더 ${String(worktrees.length)}개·입력 ${String(inputs.length)}개·브랜치 ${String(payload.branches.length)}개 정리` });
        if (commit !== null) {
          const remoteMain = await repo.remoteMain();
          if (commit !== remoteMain) {
            if (!deps.remote) return failed({ name: 'git:push', ok: false, detail: '되돌림 커밋 전송(원격 쓰기)이 아직 연결되지 않음' });
            await deps.remote.pushReset(repo, commit, remoteMain);
            items.push({ name: 'git:push', ok: true, detail: '되돌림 커밋 전송' });
          }
        }
      } catch (error) {
        if (error instanceof GitCleanupError) {
          return failed({ name: 'git:cleanup', ok: false, detail: error.failures.map((f) => `${f.name}: ${f.detail}`).join('; ').slice(0, 500) });
        }
        return failed({ name: 'git', ok: false, detail: error instanceof Error ? error.message : 'git 정리 실패' });
      }
    }
    if (payload.branches.length > 0) {
      if (!deps.remote) return failed({ name: 'github:branches', ok: false, detail: '원격 PR·브랜치 정리(원격 쓰기)가 아직 연결되지 않음' });
      try {
        await deps.remote.removeBranches(payload.branches);
        items.push({ name: 'github:branches', ok: true, detail: `원격 브랜치 ${String(payload.branches.length)}개 정리` });
      } catch (error) {
        return failed({ name: 'github:branches', ok: false, detail: error instanceof Error ? error.message : '원격 정리 실패' });
      }
    }
    return { status: 'done', items, holds: proofs };
  };
}
