import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiRequest, ApiResponse } from '../api/client.ts';
import { normalizeRepoUrl, repositoryIdFor } from '../git/identity.ts';
import { GitCleanupError, GitRepository } from '../git/repository.ts';
import { planningStateDirectory } from '../planning/checkpoint.ts';
import { atomicWrite } from '../state/files.ts';
import { RepositoryMismatch, SystemCredentialMissing, sameRepository, type RemoteCleanup } from './remote.ts';

type Command = ApiResponse<'getCommands'>['body']['commands'][number];
export type CommandResult = ApiRequest<'reportCommandResult'>['body'];
type HoldProof = Extract<CommandResult, { status: 'done' }>['holds'][number];
type Item = CommandResult['items'][number];

/**
 * 정리 명령 payload의 보유 하나. 서버 `reset_project()`가 `execution_holds` 행을 그대로 담는다(필드 이름도 DB 그대로).
 * Runner는 그중 아래 값만 쓴다. 나머지 필드(id·agent·fence 등)는 읽지 않는다.
 */
export interface PayloadHold {
  job: string;
  hostId: string | null;
  bootId: string | null;
  processGroup: number | null;
  slotState: string;
}

/**
 * `reset-cleanup` payload. 생산자는 서버 DB 함수 `reset_project()`(migrations 0012)다.
 * 공용 고정 예시: `agent-wbs/contracts/fixtures/reset-cleanup-payloads.json`(DB 시험이 실제 출력과 같은지 확인한다).
 * - 항상 있는 값: `epochPath`(서버 파일 삭제 대기열용, Runner는 쓰지 않음), `holds`, `generation`, `unparsedPrs`.
 * - 기준 커밋이 있을 때만 있는 값: `repoUrl`, `baseCommit`, `branches`, `prs`. 없으면 저장소 정리를 하지 않는다(G §9.5-2).
 */
export interface ResetPayload {
  holds: PayloadHold[];
  generation: number | null;
  unparsedPrs: unknown[];
  repo: { repoUrl: string; baseCommit: string; branches: string[]; prs: number[] } | null;
}

export class PayloadError extends Error {
  override name = 'PayloadError';
}

const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';
const optionalText = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (!isText(v)) throw new PayloadError('보유 항목의 host_id·boot_id가 올바르지 않습니다.');
  return v;
};

export function parseResetPayload(payload: Record<string, unknown>): ResetPayload {
  const { holds, generation, unparsedPrs, repoUrl, baseCommit, branches, prs } = payload;
  if (!Array.isArray(holds)) throw new PayloadError('holds 목록이 없습니다.');
  if (generation !== null && generation !== undefined && !Number.isSafeInteger(generation)) throw new PayloadError('generation이 올바르지 않습니다.');
  if (unparsedPrs !== undefined && !Array.isArray(unparsedPrs)) throw new PayloadError('unparsedPrs가 목록이 아닙니다.');
  const parsed = holds.map((h: unknown): PayloadHold => {
    if (!h || typeof h !== 'object') throw new PayloadError('보유 항목 형식이 올바르지 않습니다.');
    const row = h as Record<string, unknown>;
    if (!isText(row.job)) throw new PayloadError('보유 항목에 job이 없습니다.');
    const pgid = row.pgid ?? null;
    if (pgid !== null && (!Number.isSafeInteger(pgid) || (pgid as number) <= 1)) throw new PayloadError('보유 항목의 pgid가 올바르지 않습니다.');
    if (!isText(row.slot_state)) throw new PayloadError('보유 항목에 slot_state가 없습니다.');
    return { job: row.job, hostId: optionalText(row.host_id), bootId: optionalText(row.boot_id), processGroup: pgid as number | null, slotState: row.slot_state };
  });
  let repo: ResetPayload['repo'] = null;
  if (baseCommit !== undefined && baseCommit !== null) {
    if (typeof baseCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) throw new PayloadError('baseCommit은 전체 SHA여야 합니다.');
    if (!isText(repoUrl)) throw new PayloadError('기준 커밋이 있는데 repoUrl이 없습니다.');
    if (!Array.isArray(branches) || !branches.every((b) => isText(b) && b.startsWith('agent/'))) throw new PayloadError('branches는 agent/ 브랜치 목록이어야 합니다.');
    const list = prs ?? [];
    if (!Array.isArray(list) || !list.every((n) => Number.isSafeInteger(n) && (n as number) > 0)) throw new PayloadError('prs는 PR 번호 목록이어야 합니다.');
    repo = { repoUrl, baseCommit, branches: branches as string[], prs: list as number[] };
  }
  return { holds: parsed, generation: (generation ?? null) as number | null, unparsedPrs: (unparsedPrs ?? []) as unknown[], repo };
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
  /** 원격 쓰기(PR 닫기·브랜치 삭제·되돌림 push). GitHub 설정이 없으면 없음 → 원격 작업이 필요한 정리는 failed. */
  remote?: RemoteCleanup;
}

/** 이미 팀장에게 알린 「수동 대조 필요」 PR 참조. 같은 참조를 다음 초기화에서 다시 경고하지 않는다(조정자 결정 3-A). */
async function warnedRefs(home: string): Promise<Set<string>> {
  try {
    const value: unknown = JSON.parse(await readFile(join(home, 'state', 'reset-warned.json'), 'utf8'));
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}
const refKey = (ref: unknown) => createHash('sha256').update(JSON.stringify(ref)).digest('hex');

/**
 * M4-01 `RunnerOptions.cleanup`에 넘기는 초기화 정리.
 *
 * 순서가 중요하다.
 * 1. **먼저 모든 보유의 프로세스 종료를 증명한다.** 하나라도 증명하지 못하면 파일·브랜치를 건드리지 않고 failed로 보고한다.
 *    왜: M4-03의 잠금 회수는 잠금 주인 Node만 확인한다. 하위 git·Agent 프로세스가 살아 있는데 폴더를 지우면 안 된다(M4-03 최종 확인 §3).
 * 2. 로컬 저장소가 있으면 생성 차단(`beginReset`) → 로컬 Git 정리(M4-03 `reset`).
 * 3. 원격 정리: PR 닫기 → 기록된 원격 브랜치 삭제 → 되돌림 커밋 push(contracts §6 순서).
 * 4. 남은 작업 폴더·입력이 없음을 확인하고 생성 차단을 푼다(`endReset`). 남아 있으면 failed.
 */
export interface ResetCleanup {
  (command: Command): Promise<CommandResult>;
  /**
   * 결과가 영속 outbox에 들어간 뒤 호출한다. 그 결과에 실은 새 「수동 대조」 경고를 이미 알린 것으로 기록한다.
   * 호출 전에 죽으면 기록이 없으므로 재시도 결과에 같은 경고가 다시 실린다(유실보다 중복을 택함, 재리뷰 N5).
   */
  markReported(command: Command): Promise<void>;
}

export function createResetCleanup(deps: ResetCleanupDeps): ResetCleanup {
  const groupEmpty = deps.groupEmpty ?? processGroupEmpty;
  const launchCheck = deps.launchCheck ?? (() => Promise.resolve('unknown' as const));
  /** 명령별로 아직 기록하지 않은 새 경고 참조 해시 */
  const pending = new Map<string, string[]>();
  const cleanup = async (command: Command): Promise<CommandResult> => {
    pending.delete(command.id);
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
      const original = { job: hold.job, hostId: hold.hostId, bootId: hold.bootId };
      if (hold.hostId === null) {
        // 예약 전 보유: 어느 PC에서도 프로세스를 만든 적이 없다.
        proofs.push({ ...original, proof: 'no_process' });
        items.push({ name, ok: true, detail: '예약 전 보유 — 실행된 프로세스 없음' });
      } else if (hold.hostId !== hostId) {
        items.push({ name, ok: false, detail: '다른 PC의 보유 — 이 PC에서는 종료를 증명할 수 없음' });
      } else if (hold.bootId !== bootId) {
        proofs.push({ ...original, proof: 'boot_changed', processGroup: hold.processGroup, currentBootId: bootId });
        items.push({ name, ok: true, detail: '부팅이 바뀜 — 이전 프로세스는 존재할 수 없음' });
      } else if (hold.processGroup !== null) {
        if (groupEmpty(hold.processGroup)) {
          proofs.push({ ...original, proof: 'group_empty', processGroup: hold.processGroup });
          items.push({ name, ok: true, detail: `프로세스 그룹 ${String(hold.processGroup)} 비었음` });
        } else {
          // pgid 재사용 가능성 때문에 시작 시각·launchId 대조 없이 죽이지 않는다(§3.4-3). 실행 계층(M5-02)이 종료한 뒤 다시 시도된다.
          items.push({ name, ok: false, detail: `프로세스 그룹 ${String(hold.processGroup)}이 아직 살아 있음 — 종료 확인 뒤 다시 시도` });
        }
      } else if (hold.slotState === 'none') {
        // 물리 슬롯 없이 논리 잠금만 남은 보유: 슬롯은 CLI·① 실행 때만 잡으므로(§3.4-8) 실행 중인 프로세스가 없다.
        proofs.push({ ...original, proof: 'no_process' });
        items.push({ name, ok: true, detail: '물리 슬롯 없음(논리 잠금만) — 실행된 프로세스 없음' });
      } else if ((await launchCheck(hold)) === 'none') {
        proofs.push({ ...original, proof: 'no_process' });
        items.push({ name, ok: true, detail: 'launch 기록 대조 — 실행 명령·래퍼 없음' });
      } else {
        items.push({ name, ok: false, detail: 'launch 기록을 확인할 수 없음 — unconfirmed 유지' });
      }
    }
    if (proofs.length !== payload.holds.length) return { status: 'failed', items };
    // 외부 쓰기 권한 확인은 서버 책임이다(조정자 결정 2-A). Runner는 받은 세대를 기록만 한다.
    items.push({ name: 'authority', ok: true, detail: `외부 쓰기 권한 세대 ${payload.generation === null ? '없음' : String(payload.generation)}` });
    const failed = (item: Item): CommandResult => ({ status: 'failed', items: [...items, item], holds: proofs });

    // Planning 진행 기록(분석 결과·기술 결정 제안·초안·CP 요청 본문, M5-04)도 프로젝트 기록이다. 초기화는 남기지 않는다(G§4.2 ③).
    // 프로세스 종료를 증명한 뒤에 지운다. 지우지 못하면 정리 실패다(독립 리뷰 1).
    const planningDir = planningStateDirectory(deps.home);
    // 「없음」은 ENOENT일 때만이다. 권한 거부(EACCES) 같은 조회 오류를 없음으로 보면 기록이 남았는데 done이 된다(재리뷰 1).
    const planningFailed = (error: unknown) => failed({ name: 'planning:local', ok: false,
      detail: `Planning 진행 기록을 확인·삭제하지 못함 — ${(error instanceof Error ? error.message : '삭제 실패').slice(0, 300)}` });
    let planningExists = true;
    try { await lstat(planningDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return planningFailed(error);
      planningExists = false;
    }
    if (planningExists) {
      try { await rm(planningDir, { recursive: true, force: true }); }
      catch (error) { return planningFailed(error); }
      items.push({ name: 'planning:local', ok: true, detail: 'Planning 진행 기록 삭제' });
    }

    if (payload.repo) {
      const { repoUrl, baseCommit, branches, prs } = payload.repo;
      const repositoryId = repositoryIdFor(repoUrl);
      const exists = await lstat(join(deps.home, 'repos', repositoryId)).then(() => true, () => false);
      let repo: GitRepository | undefined;
      let resetCommit: string | null = null;
      let remoteMain: string | null = null;
      try {
        if (exists) {
          repo = await GitRepository.open(deps.home, repositoryId);
          if (normalizeRepoUrl(await repo.source()) !== normalizeRepoUrl(repoUrl)) {
            return failed({ name: 'git:open', ok: false, detail: '로컬 저장소의 등록 원격이 명령의 저장소와 다름 — 정리를 중지합니다.' });
          }
          // 목록 조회부터 최종 확인까지 새 작업 폴더·입력 생성을 막는다(교차 리뷰 P1-6).
          await repo.beginReset();
          const worktrees = await repo.recordedWorktrees();
          const inputs = await repo.inputIds();
          resetCommit = (await repo.reset({ baseCommit, branches, worktrees, inputs })).commit;
          remoteMain = await repo.remoteMain();
          items.push({ name: 'git:local', ok: true, detail: `작업 폴더 ${String(worktrees.length)}개·입력 ${String(inputs.length)}개·브랜치 ${String(branches.length)}개 정리` });
        } else {
          items.push({ name: 'git:local', ok: true, detail: '이 PC에 로컬 저장소 없음' });
        }
        const needsRevert = repo ? resetCommit !== null && resetCommit !== remoteMain : null;
        const remoteWork = prs.length > 0 || branches.length > 0 || needsRevert !== false;
        if (remoteWork && !deps.remote) return failed({ name: 'github', ok: false, detail: '원격 정리가 필요하지만 GitHub 연결 설정이 없음(AWBS_GITHUB_REPO)' });
        if (remoteWork && deps.remote) {
          // 이중 방어 1단계: 첫 원격 호출 전에 명령 저장소와 설정 저장소를 대조한다. 실행기 안에서도 같은 검사를 다시 한다(2단계).
          if (!sameRepository(repoUrl, deps.remote.repository)) {
            return failed({ name: 'github:repo', ok: false, detail: new RepositoryMismatch().message });
          }
          await deps.remote.closePullRequests(repoUrl, prs);
          if (prs.length > 0) items.push({ name: 'github:prs', ok: true, detail: `PR ${String(prs.length)}개 닫음(이미 닫힌 것 포함)` });
          await deps.remote.deleteBranches(repoUrl, branches);
          if (branches.length > 0) items.push({ name: 'github:branches', ok: true, detail: `원격 브랜치 ${String(branches.length)}개 정리` });
          if (needsRevert === true && repo && resetCommit && remoteMain) {
            await deps.remote.pushReset(repoUrl, repo, resetCommit, remoteMain);
            items.push({ name: 'git:push', ok: true, detail: '되돌림 커밋 전송' });
          } else if (needsRevert === null) {
            if (!(await deps.remote.targetsMatch(repoUrl, baseCommit))) {
              return failed({ name: 'git:push', ok: false, detail: '되돌림이 필요하지만 이 PC에 로컬 저장소가 없음(clone에 시스템 커밋 자격 증명 필요 — Q-09)' });
            }
            items.push({ name: 'git:push', ok: true, detail: '원격 main의 초기화 대상이 기준과 같음 — 되돌림 불필요' });
          }
        }
        if (repo) await repo.endReset();
      } catch (error) {
        if (error instanceof GitCleanupError) {
          return failed({ name: 'git:cleanup', ok: false, detail: error.failures.map((f) => `${f.name}: ${f.detail}`).join('; ').slice(0, 500) });
        }
        if (error instanceof SystemCredentialMissing) return failed({ name: 'git:push', ok: false, detail: error.message });
        if (error instanceof RepositoryMismatch) return failed({ name: 'github:repo', ok: false, detail: error.message });
        return failed({ name: 'cleanup', ok: false, detail: (error instanceof Error ? error.message : '정리 실패').slice(0, 500) });
      }
    }

    // 숫자로 해석하지 못한 PR 참조는 Runner가 닫을 수 없다. 완료는 막지 않되 팀장이 볼 경고로 남긴다(조정자 결정 3-A).
    if (payload.unparsedPrs.length > 0) {
      const warned = await warnedRefs(deps.home);
      const fresh = payload.unparsedPrs.filter((ref) => !warned.has(refKey(ref)));
      if (fresh.length > 0) {
        items.push({ name: 'warn:manual-reconcile', ok: false, detail: `수동 대조 필요: 해석하지 못한 PR 참조 ${String(fresh.length)}건 — ${JSON.stringify(fresh).slice(0, 400)}` });
        // 여기서는 기록하지 않는다. 결과가 outbox에 저장된 뒤 markReported가 기록한다.
        pending.set(command.id, fresh.map(refKey));
      } else {
        items.push({ name: 'manual-reconcile', ok: true, detail: `이미 알린 수동 대조 항목 ${String(payload.unparsedPrs.length)}건(새 경고 없음)` });
      }
    }
    return { status: 'done', items, holds: proofs };
  };
  return Object.assign(cleanup, {
    async markReported(command: Command): Promise<void> {
      const keys = pending.get(command.id);
      if (!keys) return;
      const warned = await warnedRefs(deps.home);
      await mkdir(join(deps.home, 'state'), { recursive: true, mode: 0o700 });
      await atomicWrite(join(deps.home, 'state'), 'reset-warned.json', JSON.stringify([...new Set([...warned, ...keys])]));
      pending.delete(command.id);
    },
  });
}
