import type { PoolClient } from '@awbs/db';
import { execPolicyToApi } from '@awbs/db';
import {
  claimReasons, startAttempt, resolveRunGrade, roleOf, effortLevel, floorOf, recommendedCaps, effectiveCaps,
  sumHolds, heldSlots, memoryPressure, attemptPolicyCounts, taskBranch, DEFAULT_EXEC_POLICY, DEFAULT_MEM_RESERVE_GB,
  type AttemptKind, type Agent, type Caps, type ClaimInput, type Catalog, type ExecPolicy,
} from '@awbs/shared';
import { gradeAdjust } from '@awbs/shared/api';
import { PlatformError } from '../platform/errors.ts';
import { writeResumeRegrade } from '../policy/resume.ts';
import { RunnerRepository, required, type Job, type Task, type Attempt } from './repository.ts';

export const EXTERNAL_JOBS = ['integrate', 'deploy_check', 'ci_retry', 'design_apply', 'merge_followup', 'bootstrap', 'input_diff'];
export const HEAD_JOBS = ['attempt', 'integrate', 'deploy_check', 'ci_retry'];
function rejection(reasons: string[]): never { throw new PlatformError('CLAIM_REJECTED', { reasons }); }
const kindOf = (job: Job) => job.payload.kind as AttemptKind;
const previous = (history: Attempt[]) => history.at(-1);
export const wireCaps = (c: Caps) => ({ total: c.total, Claude: c.perAgent.Claude, Codex: c.perAgent.Codex, heavy: c.heavy });
const domainHistory = (history: Attempt[]) => history.map(a => ({ id: a.id, kind: a.kind, status: a.status, modelId: a.model_id, effort: a.effort,
  verificationResult: a.verification_result ?? null, verificationDisposition:a.verification_disposition, automaticReworkCause: a.automatic_cause }));

export async function caps(repo: RunnerRepository) {
  const host = await repo.host();
  if (!host) rejection(['실행 PC 사양 보고가 필요합니다.']);
  const settings = await repo.settings();
  const reserve = Number(settings?.mem_reserve_gb ?? DEFAULT_MEM_RESERVE_GB);
  const recommended = recommendedCaps({ cores: host.cores, memGb: Number(host.mem_gb), diskGb: Number(host.disk_gb), perSessionGb: host.per_session_gb === null ? null : Number(host.per_session_gb) }, reserve).caps;
  const mode = (settings?.mode ?? 'auto') as 'auto' | 'manual';
  const manual = settings?.caps as { total: number; Claude: number; Codex: number; heavy: number } | null;
  return { host, mode, recommended, caps: effectiveCaps(mode, manual ? { total: manual.total, perAgent: { Claude: manual.Claude, Codex: manual.Codex }, heavy: manual.heavy } : recommended, recommended).caps, memReserveGB: reserve,
    budget: (settings?.subagent_budget ?? { dev: 0, qa: 0 }) as { dev: number; qa: number } };
}

/**
 * 실행 직전 등급(run-grade, M2-05)과 재개 등급(M2-08 `resumeGrade`)이 함께 쓰는 판정(M1-06 `resolveRunGrade`, D-29).
 * - 저장된 Task 등급이 없으면 `missing: 'grade'`.
 * - `requireUsage`이면 사용량 보고가 없을 때 `missing: 'usage'`. 아니면 남은 사용량을 모르는 채(null)로 판정한다.
 * - `history`를 주면 그 시도 이력으로 판정한다(재개할 시도까지의 이력).
 */
export async function resolveGrade(repo: RunnerRepository, task: Task, kind: AttemptKind, options: { history?: Attempt[]; requireUsage?: boolean } = {}) {
  const role = roleOf(kind);
  const agent = role === 'dev' ? task.assignee_agent : task.verifier_agent;
  const grades = await repo.grades(task.id);
  const stored = grades.find(g => g.role === role);
  if (!stored) return { missing: 'grade' as const };
  const models = await repo.models(agent);
  const catalog: Catalog = { agent, models: models.map(m => ({ modelId: m.model_id, rank: m.rank ?? 0, allowed: m.allowed,
    efforts: ((m.report as { efforts?: string[] } | null)?.efforts ?? []) })) };
  const policy = execPolicyToApi(await repo.policy(), DEFAULT_EXEC_POLICY) as ExecPolicy & { autoRetryLimit: number; autoReworkLimit: number };
  const history = options.history ?? await repo.history(task.id);
  const dev = grades.find(g => g.role === 'dev');
  const floorTask = { primaryDomain: task.primary_domain, relatedDomains: task.related_domains, devLevel: dev ? effortLevel(task.assignee_agent, dev.model_id, dev.effort) : null };
  const usage = await repo.usage(agent);
  if (!usage && options.requireUsage) return { missing: 'usage' as const };
  const result = resolveRunGrade({ kind, taskGrade: { modelId: stored.model_id, effort: stored.effort, locked: stored.locked }, task: floorTask,
    history: domainHistory(history), catalog, policy, remainPct: usage ? Number(usage.remain_pct) : null });
  return { result, history, agent, stored, policy, catalog, floorTask, role };
}

export async function runGrade(repo: RunnerRepository, task: Task, kind: AttemptKind) {
  const resolved = await resolveGrade(repo, task, kind, { requireUsage: true });
  if ('missing' in resolved) rejection([resolved.missing === 'grade' ? 'Planning의 실행 등급 판단이 필요합니다.' : '사용량 보고가 필요합니다.']);
  const { result, history, agent, stored, policy, catalog, floorTask, role } = resolved;
  if (!result.ok) rejection([result.code]);
  const adjust = gradeAdjust(result, stored.reason);
  const floor = floorOf(role, floorTask, policy.floors);
  const floorEffort = catalog.models.find(m => m.modelId === result.grade.modelId)?.efforts.find(e => effortLevel(agent, result.grade.modelId, e) === floor?.level) ?? result.grade.effort;
  return { result, history, agent, stored, policy, wire: { model: result.grade.modelId, effort: result.grade.effort, adjust, locked: stored.locked,
    floorEffort, allowedModels: catalog.models.filter(m => m.allowed).map(m => m.modelId), policy } };
}

async function capacityReasons(repo: RunnerRepository, job: Job, agent: Agent, slots: number, heavy: boolean, advertised?: number) {
  const cfg = await caps(repo);
  const total = sumHolds((await repo.holds()).map(h => ({ jobId: h.job, hostId: h.host_id, agent: h.agent, slots: h.slots, heavy: h.heavy, slotState: h.slot_state })), cfg.host.host_id, job.id);
  const concurrency = await repo.concurrency();
  const limit = Math.min(cfg.caps.total, concurrency?.limit ?? Math.min(6, cfg.caps.total), advertised ?? cfg.caps.total);
  const reasons: string[] = [];
  if (total.unconfirmedJobs.length) reasons.push('종료를 확인하지 못한 보유가 있습니다.');
  if (total.total + slots > limit) reasons.push('전체 실행 상한 또는 Runner 한도를 넘습니다.');
  if (total.perAgent[agent] + slots > cfg.caps.perAgent[agent]) reasons.push('Agent 실행 상한을 넘습니다.');
  if (heavy && total.heavy + 1 > cfg.caps.heavy) reasons.push('무거운 작업 상한을 넘습니다.');
  if (concurrency && memoryPressure(Number((concurrency.resources as { memFreeGB: number }).memFreeGB), Number((concurrency.resources as { swapGB: number }).swapGB), cfg.memReserveGB)) reasons.push('메모리 여유 또는 swap 사용을 확인하세요.');
  return reasons;
}

async function checkAttempt(repo: RunnerRepository, job: Job, task: Task, advertised?: number) {
  const cfg = await caps(repo);
  const kind = kindOf(job);
  const grade = await runGrade(repo, task, kind);
  const history = grade.history;
  const prev = previous(history);
  const holds = await repo.holds();
  const dependencies = await repo.dependencies(task.id);
  const taskCheckPassed = await repo.taskCheck(task, task.execution_head_sha ?? prev?.head_sha);
  const taskCheckFailed = task.status === 'rework' && prev?.status === 'failed' &&
    (await repo.client.query<{ status: string; fail_scope: string | null }>('select status,fail_scope from ci_runs where attempt=$1 and stage=1 order by run_no desc limit 1', [prev.id])).rows.some(c => c.status === 'fail' && c.fail_scope === 'task');
  const input: ClaimInput = {
    status: task.status, kind, previousAttempt: domainHistory(history).at(-1) ?? null, hasOpenAttempt: history.some(a => a.status === 'running'),
    jobId: job.id, epoch: job.epoch, hostId: cfg.host.host_id,
    holds: holds.filter(h => h.task === task.id || h.conflict_group !== null && h.conflict_group === task.conflict_group).map(h => ({ jobId: h.job, epoch: h.epoch, hostId: h.host_id,
      slotState: h.slot_state, lockState: h.lock_state, lockFromJobId: h.lock_from_job, handedToJobId: h.handed_to_job })),
    cleanupPending: await repo.cleanup(), dependenciesMet: dependencies.every(d => d.dep_type === 'FS' ? d.status === 'done' : !['planning','approval','ready','cancelled'].includes(d.status)),
    leaderRequested: job.payload.leaderRequested === true, taskCheckPassed, taskCheckFailed, integrationFailed: job.payload.integrationFailed === true,
    autoRetryLimit: grade.policy.autoRetryLimit, autoReworkLimit: grade.policy.autoReworkLimit,
    evidenceInvalidated: job.payload.evidenceInvalidated === true, history: domainHistory(history), modelId: grade.result.grade.modelId, effort: grade.result.grade.effort,
    resumeGrade: { previousModelAllowed: !grade.result.adjust.replaced, reassessed: Boolean(grade.result.adjust.replaced), modelId: grade.result.grade.modelId,
      effort: grade.result.grade.effort, reason: grade.stored.reason },
  };
  const reasons = claimReasons(input);
  const ready = await repo.readiness();
  for (const key of [grade.agent.toLowerCase(), 'git', 'node', 'pnpm', 'pg', 'repo', 'disk', 'subs']) {
    const item = ready.find(r => r.key === key);
    if (!item || item.status === 'fail') reasons.push(`준비 점검이 필요합니다: ${key}`);
  }
  const slots = heldSlots({ grade: 'unverified', state: 'ok', observed: 0, budget: cfg.budget[roleOf(kind)], previousHeld: 0 });
  reasons.push(...await capacityReasons(repo, job, grade.agent, slots, false, advertised));
  if (reasons.length) rejection(reasons);
  return { cfg, grade, input, slots };
}

export function externalWriteAllowed(authority: {state:string;host_id:string;generation:number}|undefined, host: string|null|undefined, generation:number|null|undefined) {
  return Boolean(authority && authority.state==='granted' && authority.host_id===host && generation===authority.generation);
}

/**
 * job이 없으면(설계 계약 반영처럼 job을 만들기 전의 사전 확인, M6-05) 세대 대조 없이 권한·host만 본다.
 * 왜: 아직 만들지 않은 job은 세대가 없다. 만들 job은 지금 세대로 들어가므로 지금 세대와 같다고 본다(M6 통합 병합).
 */
export async function assertExternal(repo: RunnerRepository, job?: Pick<Job, 'generation'>) {
  const authority = await repo.authority();
  const host = await repo.host();
  if (!externalWriteAllowed(authority,host?.host_id,job ? job.generation : authority?.generation)) throw new PlatformError('EXTERNAL_WRITE_BLOCKED', { generation: authority?.generation });
}

export async function checkedJob(repo: RunnerRepository, id: string, fence: number, principal: string, reconcile = false) {
  const job = await repo.job(id);
  if (!job) throw new PlatformError('NOT_FOUND', { resource: 'runner_job', id });
  if (job.fence !== fence || job.lease_owner !== principal || (!reconcile && (!['leased','started'].includes(job.state) || !job.lease_until || job.lease_until <= await repo.now()))) throw new PlatformError('LEASE_LOST');
  if (!reconcile && EXTERNAL_JOBS.includes(job.kind)) await assertExternal(repo, job);
  return job;
}

export async function claim(repo: RunnerRepository, kinds: string[], capacity: number, epoch: number, principal: string) {
  await repo.lock();
  if (await repo.cleanup()) throw new PlatformError('CLEANUP_PENDING');
  if (capacity === 0 && !kinds.includes('stop_attempt')) return null;
  const cfg = await caps(repo);
  for (const candidate of await repo.candidates(kinds, epoch)) {
    let task: Task | undefined;
    let agent: Agent = 'Codex', slots = 1;
    try {
      if (candidate.kind === 'attempt') {
        task = await repo.task(candidate.payload.taskKey as string);
        if (!task) continue;
        const check = await checkAttempt(repo, candidate, task, capacity);
        agent = check.grade.agent; slots = check.slots;
      } else if (candidate.kind !== 'stop_attempt') {
        if (candidate.kind === 'integrate' && typeof candidate.payload.taskKey === 'string') {
          task = await repo.task(candidate.payload.taskKey as string);
          if (!task || task.status !== 'gate') continue;
        }
        const reasons = await capacityReasons(repo, candidate, agent, slots, true, capacity);
        if (capacity === 0 || reasons.length) continue;
      }
      const authority = await repo.authority();
      if (EXTERNAL_JOBS.includes(candidate.kind) && authority?.state !== 'granted') continue;
      const job = await repo.lease(candidate, principal, authority?.generation ?? null);
      // 조회 전용 작업은 이전 임대의 프로세스를 보유하지 않는다.
      if (!['repo_check', 'github_check', 'stop_attempt'].includes(job.kind)) await repo.reserve(job, cfg.host.host_id, required(cfg.host.boot_id), agent, slots, job.kind !== 'attempt', task);
      await repo.event(job, 'prepared');
      return { id: job.id, kind: job.kind, payload: job.payload, fence: job.fence, leaseUntil: required(job.lease_until).toISOString() };
    } catch (error) {
      if (!(error instanceof PlatformError) || error.code !== 'CLAIM_REJECTED') throw error;
      // 대기 사유를 같은 job 이력에 남겨 화면에서 원인을 확인할 수 있게 한다.
      await repo.event(candidate, 'prepared', error.code, error.details);
    }
  }
  return null;
}

export async function start(repo: RunnerRepository, job: Job, body: { hostId: string; bootId: string; headSha?: string; installedSubagents: { id: string; version: number; hash: string }[] }) {
  const needsHead = HEAD_JOBS.includes(job.kind);
  if (needsHead !== Boolean(body.headSha)) throw new PlatformError('VALIDATION_FAILED');
  const host = await repo.host();
  if (body.hostId !== host?.host_id || body.bootId !== host.boot_id) rejection(['현재 PC와 부팅 ID가 달라졌습니다.']);
  if (job.kind !== 'attempt') { await repo.state(job.id, 'started'); return {}; }
  const task = await repo.task(job.payload.taskKey as string);
  if (!task) throw new PlatformError('TASK_NOT_FOUND');
  const existing = (await repo.history(task.id)).find(a => a.job === job.id);
  if (existing) return { attemptId: existing.id };
  const check = await checkAttempt(repo, job, task);
  const defs = await repo.subagents(task.id, roleOf(kindOf(job)));
  const installed = defs.length === body.installedSubagents.length && new Set(body.installedSubagents.map(i => i.id)).size === defs.length && defs.every(d => d.allowed && body.installedSubagents.some(i => i.id === d.id && i.version === d.version && i.hash === d.hash));
  if (!installed) throw new PlatformError('SUBAGENT_INSTALL_FAILED');
  startAttempt(check.input, true);
  const prev = previous(check.grade.history);
  if ((kindOf(job) === 'qa' || kindOf(job) === 'reverify') && (task.execution_head_sha ?? prev?.head_sha) !== body.headSha) rejection(['①에서 검사한 현재 head로 검증해야 합니다.']);
  const attemptId = await repo.createAttempt(job, task, kindOf(job), body.hostId, required(body.headSha), check.grade.wire.model, check.grade.wire.effort, check.grade.wire.adjust,
    prev?.status === 'interrupted' ? prev.id : null);
  await repo.saveInstalled(task, attemptId, body.installedSubagents);
  await repo.historyEvent(task, '시도 시작', { attemptId, adjust: check.grade.wire.adjust });
  // D-29: 중단된 시도를 재판단한 등급으로 이어 가면 이전→이후 등급을 이력에 남긴다(M2-08 recordResumeRegrade와 같은 기록).
  if (prev?.status === 'interrupted') await writeResumeRegrade(repo.client, task, prev.id, check.grade.result);
  return { attemptId };
}

export interface Proof { kind: 'no_process' | 'group_empty' | 'boot_changed'; bootId: string; processGroup?: number | null; currentBootId?: string }
export async function release(repo: RunnerRepository, job: Job, host: string, proof: Proof, slotsOnly: boolean) {
  const hold = await repo.hold(job.id);
  if (!hold || hold.host_id !== host || hold.boot_id !== proof.bootId || hold.fence !== job.fence) throw new PlatformError('INVALID_TRANSITION');
  if (proof.kind === 'no_process' && (hold.pgid !== null || hold.cgroup !== null) || proof.kind === 'group_empty' && hold.pgid !== proof.processGroup ||
    proof.kind === 'boot_changed' && (hold.pgid !== proof.processGroup || proof.currentBootId === proof.bootId || proof.currentBootId !== await repo.hostBoot(host))) throw new PlatformError('INVALID_TRANSITION');
  if (hold.closed_at) return;
  const task = hold.task ? await repo.taskById(hold.task) : undefined;
  if (!slotsOnly && task && !['paused','failed'].includes(task.status) && !['failed','cancelled','done','reconcile'].includes(job.state)) throw new PlatformError('INVALID_TRANSITION');
  await repo.release(hold, proof.kind, !slotsOnly);
}

async function attemptPayload(repo: RunnerRepository, task: Task, kind: AttemptKind, extra: object) {
  const input = await repo.input(task.project_id,task.src_input_version);
  const authority = await repo.authority();
  const spec = await repo.spec(task.id);
  if (!spec) rejection(['Task 명세가 필요합니다.']);
  const prev = previous(await repo.history(task.id));
  const agent = roleOf(kind) === 'dev' ? task.assignee_agent : task.verifier_agent;
  return { taskKey: task.task_key, kind, agent, branch: taskBranch(task.task_key, authority?.generation ?? 1),
    baseCommit: input?.commit_sha ?? prev?.head_sha, inputVersion: input?.v ?? 1, instructions: { ...spec },
    evidenceInvalidated:task.status === 'verifying' && prev?.verification_disposition === 'stale',...extra };
}

export async function requestRun(repo: RunnerRepository, task: Task, kind: AttemptKind, epoch: number) {
  const existing = await repo.openJob(task.task_key);
  if (existing) rejection(['이미 대기 중이거나 실행 중인 요청이 있습니다.']);
  const payload = await attemptPayload(repo, task, kind, { leaderRequested: true });
  if (!payload.baseCommit) rejection(['입력 기준 커밋 보고가 필요합니다.']);
  const mock: Job = { id: '00000000-0000-4000-8000-000000000000', epoch, payload } as Job;
  await checkAttempt(repo, mock, task);
  const id = await repo.enqueue(task.project_id, epoch, 'attempt', payload, `manual:${task.id}:${randomUUID()}`);
  await repo.historyEvent(task, '팀장 실행 요청', { jobId: id, kind });
  return required(id);
}

import { randomUUID } from 'node:crypto';

/** 결과 서비스(M2-06)가 Task 전이·①/검증 근거 저장과 같은 트랜잭션에서 호출한다. */
export async function handover(client: PoolClient, fromJob: string, kind: AttemptKind, cause: string, extra: object = {}) {
  const repo = new RunnerRepository(client);
  await repo.lock();
  const job = await repo.job(fromJob);
  if (!job) throw new PlatformError('NOT_FOUND');
  const hold = await repo.hold(fromJob);
  if (hold?.handed_to_job) return hold.handed_to_job;
  if (!hold || hold.slot_state !== 'none' || hold.lock_state !== 'held') throw new PlatformError('INVALID_TRANSITION');
  const task = await repo.taskById(required(hold.task));
  if (!task) throw new PlatformError('TASK_NOT_FOUND');
  const history = await repo.history(task.id);
  const reworkCause = (extra as { automaticCause?: string }).automaticCause ?? cause;
  if (kind === 'rework' && !history.some(a => a.automatic_cause === reworkCause) && attemptPolicyCounts(domainHistory(history)).automaticReworks >= (await repo.policy()).auto_rework_limit) {
    await repo.release(hold, required(hold.release_proof), true);
    await repo.alert(task.project_id, `rework-limit:${task.id}`, '자동 재작업 한도를 넘었습니다.', { cause,taskKey:task.task_key });
    return null;
  }
  const payload = await attemptPayload(repo, task, kind, { ...extra, leaderRequested: false, ...(kind === 'rework' ? { automaticCause: reworkCause } : {}) });
  const next = await repo.enqueue(task.project_id, job.epoch, 'attempt', payload, `next:${cause}:${kind}`, job.generation);
  if (!next) throw new PlatformError('INVALID_TRANSITION');
  await repo.transfer(hold, next);
  if (!['done','failed','cancelled'].includes(job.state)) await repo.state(job.id, 'done');
  return next;
}

export async function retryFailedAttempt(client: PoolClient, attemptId: string) {
  const repo = new RunnerRepository(client);
  await repo.lock();
  const a = await repo.attempt(attemptId);
  if (!a || a.status !== 'failed') throw new PlatformError('INVALID_TRANSITION');
  const task = await repo.taskById(a.task);
  if (!task) throw new PlatformError('TASK_NOT_FOUND');
  const hold = await repo.hold(a.job);
  if (hold?.handed_to_job) return hold.handed_to_job;
  const count = attemptPolicyCounts(domainHistory(await repo.history(task.id))).consecutiveFailures[a.kind];
  const job = await repo.job(a.job);
  if (count <= (await repo.policy()).auto_retry_limit) return handover(client, a.job, a.kind, a.id, { automaticCause: job?.payload.automaticCause });
  if (job && !['done','failed','cancelled'].includes(job.state)) await repo.state(job.id, 'failed');
  if (hold?.slot_state === 'none' && !hold.closed_at) await repo.release(hold, required(hold.release_proof), true);
  await repo.alert(task.project_id, `retry:${a.id}`, '실행 실패의 자동 재시도 한도를 넘었습니다.', { taskKey: task.task_key, attemptId });
  return null;
}

/** GitHub 대조 모듈이 직접 확인한 증거만 전달한다. Runner HTTP 본문으로 권한을 부여하지 않는다. */
export async function grantExternalAfterReconcile(client: PoolClient, generation: number, proof: {
  oldHostStopped: boolean; oldOutboxDrained: boolean; oldCallsChecked: boolean;
  credentialRevoked: boolean; oldCredentialStatus: number | null; newCredentialRegistered: boolean;
  mainChecked: boolean; prsChecked: boolean; branchesChecked: boolean; statusesChecked: boolean;
}) {
  const repo = new RunnerRepository(client);
  await repo.lock();
  const authority = await repo.authority();
  const stopped = proof.oldHostStopped && proof.oldOutboxDrained && proof.oldCallsChecked;
  const revoked = proof.credentialRevoked && proof.oldCredentialStatus === 401 && proof.newCredentialRegistered;
  if (!authority || authority.generation !== generation || !(stopped || revoked) || !proof.mainChecked || !proof.prsChecked || !proof.branchesChecked || !proof.statusesChecked) throw new PlatformError('EXTERNAL_WRITE_BLOCKED');
  await repo.grantAuthority(generation);
}
