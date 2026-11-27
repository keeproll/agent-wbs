import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Pool } from '@awbs/db';
import type { Agent, AttemptKind, ModelSettings, RunRole } from '@awbs/shared';
import { fromDb, OBSERVATION_GRADE } from '@awbs/db';
import { OPERATIONS } from '@awbs/shared/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PlatformError } from '../platform/errors.ts';
import { inEpoch } from '../platform/transaction.ts';
import { RunnerRepository, required } from './repository.ts';
import { caps, claim, checkedJob, release, requestRun, runGrade, start, retryFailedAttempt, wireCaps, type Proof } from './service.ts';
import { reportConcurrency, reportHost } from './telemetry.ts';
import { runnerState } from './state.ts';
import { installResetRunner } from '../reset/routes.ts';

const params = (r: FastifyRequest) => r.params as { id: string; taskKey: string; attemptId: string };
const body = <T>(r: FastifyRequest) => r.body as T;
const principal = (r: FastifyRequest) => { assert(r.platform); return r.platform.principal; };

/** 플랫폼이 연 트랜잭션을 그대로 사용한다. 별도 트랜잭션을 열면 멱등 응답과 업무 변경이 갈라진다. */
export function installRunner(app: FastifyInstance, pool: Pool) {
  installResetRunner(app, pool);
  const route = (id: string, handler: (repo: RunnerRepository, r: FastifyRequest) => Promise<unknown>, status = 200) => {
    const op = OPERATIONS.find(o => o.id === id);
    assert(op);
    const response = Object.fromEntries(Object.entries(op.responses).filter(([, schema]) => schema !== null));
    app.route({ method: op.method, url: op.path, schema: { ...(op.body && { body: op.body }), ...(op.query && { querystring: op.query }),
      ...(id !== 'claimJob' && { response }) }, handler: async (r, reply) => {
      const execute = async (repo: RunnerRepository) => { await repo.lock(); return handler(repo, r); };
      const client = r.platform?.client;
      const result = client ? await execute(new RunnerRepository(client)) : await inEpoch(pool, r.platform?.currentEpoch ?? 0, c => execute(new RunnerRepository(c)));
      if (id === 'getRunnerPolicy') {
        const etag = `"${createHash('sha256').update(JSON.stringify(result)).digest('hex')}"`;
        reply.header('ETag', etag);
        if (r.headers['if-none-match'] === etag) return reply.code(304).send();
      }
      if (id === 'claimJob' && result === null) return reply.code(204).send();
      if (result === undefined) return reply.code(status).send();
      return reply.code(status).send(result);
    } });
  };
  route('heartbeat', async (repo, r) => {
    // 낡은 세대의 생존 보고는 최신 세대 번호만 응답하고 새 실행 상태를 만지지 않는다.
    if (r.platform?.epoch === r.platform?.currentEpoch) await repo.heartbeat(principal(r).slice(7));
  }, 204);
  route('reportSession', async (repo, r) => {
    const b = body<{ runnerId: string; event: string; at: string; reason?: string }>(r);
    const open = (await repo.sessions()).some(s => s.runner_id === b.runnerId && !s.ended_at);
    if (b.event === 'stop' && !open || b.event === 'start' && open) throw new PlatformError('INVALID_TRANSITION');
    await repo.session(b.runnerId, b.event, b.at, b.reason);
  }, 204);
  route('reportHost', (repo, r) => reportHost(repo, body<Parameters<typeof reportHost>[1]>(r)));
  route('reportReadiness', async (repo, r) => {
    const b = body<{ at: string; items: Parameters<RunnerRepository['saveReadiness']>[1]; cli?: { agent: string; version: string; model: string; options: string }[] }>(r);
    await repo.saveReadiness(b.at, b.items);
    for (const cli of b.cli ?? []) await repo.saveObservationConfig(cli.agent, { ...cli, cli: cli.agent });
  }, 204);
  route('reportModels', async (repo, r) => {
    const b = body<{ agent: Agent; models: Parameters<RunnerRepository['saveModels']>[1] }>(r);
    return { newModels: await repo.saveModels(b.agent, b.models) };
  });
  route('reportUsage', async (repo, r) => { await repo.saveUsage(body<Parameters<RunnerRepository['saveUsage']>[0]>(r)); }, 204);
  route('reportConcurrency', (repo, r) => reportConcurrency(repo, body<Parameters<typeof reportConcurrency>[1]>(r)));
  route('getRunGrade', async (repo, r) => {
    const task = await repo.task(params(r).taskKey);
    if (!task) throw new PlatformError('TASK_NOT_FOUND');
    const role = (r.query as { role: RunRole }).role;
    const prev = (await repo.history(task.id)).findLast(a => (a.kind === 'dev' || a.kind === 'rework' ? 'dev' : 'qa') === role);
    const kind = prev && (prev.status === 'interrupted' || prev.status === 'failed') ? prev.kind : role === 'dev' ? task.status === 'rework' ? 'rework' : 'dev' : task.status === 'verifying' ? 'reverify' : 'qa';
    return (await runGrade(repo, task, kind)).wire;
  });
  route('getExecutionHolds', async (repo, r) => ({ holds: await repo.ownedHolds(principal(r), required(r.platform).epoch) }));
  route('getTaskSubagents', async (repo, r) => {
    const task = await repo.task(params(r).taskKey);
    if (!task) throw new PlatformError('TASK_NOT_FOUND');
    const defs = await repo.subagents(task.id, (r.query as { role: string }).role);
    if (defs.some(d => !d.allowed)) throw new PlatformError('CLAIM_REJECTED', { reasons: ['지정한 하위 Agent의 재판단이 필요합니다.'] });
    return { enabled: defs.length > 0, items: defs.map(d => ({ id: d.id, key: d.def_key, agent: d.agent, version: d.version, hash: d.hash, file: d.text, sandbox: d.sandbox })) };
  });
  route('claimJob', async (repo, r) => {
    const b = body<{ kinds: string[]; capacity: number }>(r);
    const job = await claim(repo, b.kinds, b.capacity, required(r.platform).epoch, principal(r));
    // 204는 이 경로만 결과에 따라 달라진다.
    return job ? { job } : null;
  });
  route('renewJob', async (repo, r) => {
    const job = await checkedJob(repo, params(r).id, body<{ fence: number }>(r).fence, principal(r));
    return { leaseUntil: (await repo.renew(job.id)).toISOString() };
  });
  route('startJob', async (repo, r) => {
    const b = body<Parameters<typeof start>[2] & { fence: number }>(r);
    const job = await checkedJob(repo, params(r).id, b.fence, principal(r));
    return start(repo, job, b);
  });
  route('reportJobProcess', async (repo, r) => {
    const b = body<{ fence: number; processGroup: number; cgroup: string | null }>(r);
    const job = await checkedJob(repo, params(r).id, b.fence, principal(r));
    const h = await repo.hold(job.id);
    if (!h || h.fence !== b.fence || h.slot_state !== 'reserved' && !(h.slot_state === 'active' && h.pgid === b.processGroup && h.cgroup === b.cgroup)) throw new PlatformError('INVALID_TRANSITION');
    if (h.slot_state === 'reserved') await repo.process(job.id, b.processGroup, b.cgroup);
  }, 204);
  for (const [id, slotsOnly] of [['releaseJobSlots', true], ['releaseJob', false]] as const) route(id, async (repo, r) => {
    const b = body<{ fence: number; hostId: string; proof: Proof; at: string }>(r);
    const job = await repo.job(params(r).id);
    if (!job) throw new PlatformError('NOT_FOUND');
    // 해제만 원래 보유의 fence를 허용한다. 새 소유자의 보유는 바꾸지 못한다.
    const h = await repo.hold(job.id);
    if (!h || h.fence !== b.fence || job.lease_owner !== principal(r)) throw new PlatformError('LEASE_LOST');
    const a = h.attempt ? await repo.attempt(h.attempt) : undefined;
    // 실패 후 재시도 인계에는 논리 잠금이 필요하므로 슬롯부터 반환한다.
    if (!slotsOnly && a?.status === 'failed' && !h.closed_at) {
      await release(repo, { ...job, fence: b.fence }, b.hostId, b.proof, true);
      await retryFailedAttempt(repo.client, a.id);
    } else await release(repo, { ...job, fence: b.fence }, b.hostId, b.proof, slotsOnly);
  }, 204);
  route('acquireJobSlots', async (repo, r) => {
    const b = body<{ fence: number; hostId: string }>(r);
    const job = await checkedJob(repo, params(r).id, b.fence, principal(r));
    const h = await repo.hold(job.id), config = await caps(repo);
    if (!h || h.host_id !== b.hostId || b.hostId !== config.host.host_id || h.fence !== b.fence || h.slot_state !== 'none' || h.closed_at) throw new PlatformError('INVALID_TRANSITION');
    const { sumHolds } = await import('@awbs/shared');
    const totals = sumHolds((await repo.holds()).map(h => ({ jobId: h.job, hostId: h.host_id, agent: h.agent, slots: h.slots, heavy: h.heavy, slotState: h.slot_state })), b.hostId, job.id);
    const conc = await repo.concurrency();
    if (totals.unconfirmedJobs.length || totals.total + h.slots > Math.min(config.caps.total, conc?.limit ?? 6) || totals.perAgent[h.agent] + h.slots > config.caps.perAgent[h.agent] || totals.heavy + 1 > config.caps.heavy) throw new PlatformError('CLAIM_REJECTED', { reasons: ['검사 실행 용량이 부족합니다.'] });
    await repo.reserve(job, b.hostId, required(config.host.boot_id), h.agent, h.slots, true);
  }, 204);
  route('finishJob', async (repo, r) => {
    const b = body<{ fence: number; status: 'done' | 'failed' | 'cancelled'; result?: object; error?: { code: string; message: string } }>(r);
    const job = await checkedJob(repo, params(r).id, b.fence, principal(r));
    const h = await repo.hold(job.id);
    if (h?.attempt && job.kind === 'attempt') throw new PlatformError('INVALID_TRANSITION');
    const prestartFailed = b.status === 'failed' && job.state === 'leased';
    await repo.event(job, prestartFailed ? 'prestart_failed' : 'finished', b.error?.code ?? null, { result: b.result, error: b.error });
    if (prestartFailed && job.kind === 'attempt') {
      const task = await repo.task(job.payload.taskKey as string);
      if (!task) throw new PlatformError('TASK_NOT_FOUND');
      await repo.historyEvent(task, '시작 전 실패', { jobId:job.id,error:b.error ?? null });
    }
    await repo.state(job.id, b.status);
  }, 204);
  route('reconcileJob', async (repo, r) => {
    const b = body<{ fence: number; evidence: { outcome: 'none' | 'done' | 'partial'; checkedAt: string; detail: object } }>(r);
    const job = await checkedJob(repo, params(r).id, b.fence, principal(r), true);
    const h = await repo.hold(job.id);
    if (job.state !== 'reconcile' || h && h.slot_state !== 'none') throw new PlatformError('INVALID_TRANSITION');
    await repo.event(job, 'reconciled', null, b.evidence);
    await repo.state(job.id, b.evidence.outcome === 'done' ? 'done' : 'failed');
    if (h && !h.closed_at) await repo.release(h, required(h.release_proof), true);
    if (b.evidence.outcome === 'none') await repo.enqueue(job.project_id, job.epoch, job.kind, job.payload, `reconcile:${job.id}:${job.fence}`, job.generation);
  }, 204);
  route('interruptAttempt', async (repo, r) => {
    const b = body<{ fence: number; reason: string; at: string }>(r);
    const a = await repo.attempt(params(r).attemptId);
    if (!a) throw new PlatformError('ATTEMPT_NOT_FOUND');
    await checkedJob(repo, a.job, b.fence, principal(r));
    if (a.status !== 'running') throw new PlatformError('ATTEMPT_CLOSED');
    await repo.closeAttempt(a, 'interrupted', new Date(b.at), { reason: b.reason });
    await repo.unconfirm(a.job);
    await repo.state(a.job, 'cancelled');
    return { taskStatus: 'paused' };
  });
  route('reportAttemptStatus', async (repo, r) => {
    const b = body<{ fence: number; status: string; at: string; model: string; effort: string; adjust?: object }>(r);
    const a = await repo.attempt(params(r).attemptId);
    if (!a) throw new PlatformError('ATTEMPT_NOT_FOUND');
    await checkedJob(repo, a.job, b.fence, principal(r));
    if (a.status !== 'running') throw new PlatformError('ATTEMPT_CLOSED');
    if (a.model_id !== b.model || a.effort !== b.effort) throw new PlatformError('CLAIM_REJECTED', { reasons: ['시작 때 판정한 모델과 Effort로 실행해야 합니다.'] });
    if (b.status === 'failed') {
      await repo.closeAttempt(a, 'failed', new Date(b.at), { reason: 'process_failed' });
      await repo.unconfirm(a.job);
    }
  }, 204);
  route('requestRun', async (repo, r) => {
    const b = body<{ updatedAt: string; kind: AttemptKind }>(r);
    const task = await repo.task(params(r).taskKey);
    if (!task) throw new PlatformError('TASK_NOT_FOUND');
    if (!await repo.versionMatches(task.id, b.updatedAt)) throw new PlatformError('VERSION_CONFLICT');
    return { jobId: await requestRun(repo, task, b.kind, required(r.platform).epoch) };
  }, 202);
  route('resumeAttempt', async (repo, r) => {
    const a = await repo.attempt(params(r).attemptId);
    if (!a) throw new PlatformError('ATTEMPT_NOT_FOUND');
    const task = await repo.taskById(a.task);
    if (!task) throw new PlatformError('TASK_NOT_FOUND');
    if (!await repo.versionMatches(task.id, body<{ updatedAt: string }>(r).updatedAt)) throw new PlatformError('VERSION_CONFLICT');
    if (a.status !== 'interrupted' || (await repo.history(task.id)).at(-1)?.id !== a.id) throw new PlatformError('CLAIM_REJECTED');
    return { jobId: await requestRun(repo, task, a.kind, required(r.platform).epoch) };
  }, 202);
  route('stopAttempt', async (repo, r) => {
    const b = body<{ updatedAt: string; attemptUpdatedAt: string }>(r);
    const a = await repo.attempt(params(r).attemptId);
    if (!a) throw new PlatformError('ATTEMPT_NOT_FOUND');
    const task = await repo.taskById(a.task);
    if (!task) throw new PlatformError('TASK_NOT_FOUND');
    if (!await repo.versionMatches(task.id, b.updatedAt) || !await repo.versionMatches(a.id, b.attemptUpdatedAt, 'task_attempts')) throw new PlatformError('VERSION_CONFLICT');
    if (a.status !== 'running') throw new PlatformError('ATTEMPT_CLOSED');
    return { jobId: await repo.enqueue(task.project_id, required(r.platform).epoch, 'stop_attempt', { attemptId: a.id, reason: 'manual' }, `stop:${a.id}`) };
  }, 202);
  route('getRunnerPolicy', async (repo) => {
    const c = await caps(repo), settings = await repo.appSettings();
    const ci = await repo.ciSettings();
    const models = settings.model_settings as unknown as ModelSettings;
    const cliGrades = (await repo.observations()).map(o => ({ agent:o.cli,version:o.version,model:o.model,options:o.options,grade:fromDb(OBSERVATION_GRADE,o.grade) }));
    // shortcut: 입력 확인은 5분 주기다. 공통 설정에 주기 항목이 생기면 그 값을 읽는다.
    return { caps: { ...wireCaps(c.caps), memReserveGB: c.memReserveGB }, subagentBudget: c.budget, heartbeatSeconds: settings.heartbeat_seconds,
      inputCheckMinutes: 5, inputRecheck: await repo.inputRecheck(), inputCheckRequest: await repo.inputCheckRequest(), readinessCheckRequest: settings.readiness_check_request, githubMode: (await repo.githubSettings())?.mode ?? 'gh', ci: { nightAt: ci.night_at, retry: ci.retry, deployUrl: ci.deploy_url },claudeModels:models.claudeModels,cliGrades };
  });
  route('getRunnerState', repo => runnerState(repo));
}
