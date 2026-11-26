import { fromDb, OBSERVATION_GRADE } from '@awbs/db';
import { concurrency, memoryPressure, parallelWidth, sumHolds, type ObservationKey } from '@awbs/shared';
import { RunnerRepository, required } from './repository.ts';
import { caps, wireCaps } from './service.ts';

export async function runnerState(repo: RunnerRepository) {
  const host = await repo.host();
  const cfg = host ? await caps(repo) : null;
  const hosts = await repo.hostHistory(), sessions = await repo.sessions(), tasks = await repo.allTasks(), holds = await repo.holds();
  const settings = await repo.settings(), app = await repo.appSettings(), conc = await repo.concurrency();
  const at = await repo.now();
  const session = sessions.at(-1);
  const readiness = await repo.readiness();
  const rows = holds.map(h => ({ jobId: h.job, hostId: h.host_id, agent: h.agent, slots: h.slots, heavy: h.heavy, slotState: h.slot_state }));
  const totals = sumHolds(rows, host?.host_id ?? '');
  const running = tasks.filter(t => holds.some(h => h.task === t.id && h.lock_state === 'held')).map(t => ({ taskKey: t.task_key, conflictGroup: t.conflict_group }));
  const startable = [];
  for (const task of tasks.filter(t => t.status === 'ready')) {
    if ((await repo.dependencies(task.id)).every(d => d.dep_type === 'FS' ? d.status === 'done' : !['planning','approval','ready','cancelled'].includes(d.status))) startable.push({ taskKey: task.task_key, conflictGroup: task.conflict_group });
  }
  const width = parallelWidth({ running, startable });
  const factor = concurrency({ capTotal: cfg?.caps.total ?? 0, runnerLimit: conc?.limit ?? Math.min(6,cfg?.caps.total ?? 0), width: width.width, subRatio: 0 });
  const observations = [];
  for (const h of holds.filter(h => h.attempt && h.host_id === host?.host_id)) {
    const a = await repo.attempt(required(h.attempt));
    if (!a || a.status !== 'running') continue;
    const o = await repo.latestObservation(a.id);
    observations.push({ attemptId: a.id, taskKey: required(tasks.find(t => t.id === a.task)).task_key, agent: a.agent, observed: o?.observed ?? 0,
      reserved: o?.reserved ?? Math.max(0,h.slots-1), state: o?.state ?? 'ok', grade: o ? fromDb(OBSERVATION_GRADE,o.grade) : 'unverified' });
  }
  const profiles = [];
  for (const agent of ['Claude','Codex'] as const) {
    const cli = (await repo.observationConfig(agent))?.conditions as ObservationKey | undefined;
    if (!cli) continue;
    const registered = (await repo.observations()).find(o => o.cli === cli.cli && o.version === cli.version && o.model === cli.model && o.options === cli.options);
    profiles.push({ agent, version: cli.version, model: cli.model, options: cli.options, grade: registered ? fromDb(OBSERVATION_GRADE,registered.grade) : 'unverified',
      verifiedVersion: registered?.version ?? null, verifiedAt: registered?.verified_at ?? null, notes: registered?.notes ?? '' });
  }
  const resources = conc?.resources as { cpuPct: number; memFreeGB: number; swapGB: number } | undefined;
  const authority = await repo.authority();
  return {
    connection: { online: Boolean(session && !session.ended_at && at.getTime()-session.last_heartbeat_at.getTime() < app.heartbeat_seconds*app.heartbeat_misses*1000),
      runnerId: session?.runner_id ?? null, version: null, lastHeartbeatAt: session?.last_heartbeat_at ?? null, sessionStartedAt: session?.started_at ?? null },
    readiness: readiness.length ? { at: readiness.map(r => r.at).sort().at(-1), items: readiness.map(r => ({ key:r.key,status:r.status,detail:r.detail,fix:r.fix || null })) } : null,
    host: host && cfg ? { hostId:host.host_id,bootId:host.boot_id,cpu:host.cpu,cores:host.cores,memGB:Number(host.mem_gb),swapGB:Number(host.swap_gb),diskFreeGB:Number(host.disk_gb),os:host.os,
      perSessionGB:host.per_session_gb === null ? null : Number(host.per_session_gb),samples:host.samples,seenAt:host.seen_at,recommended:wireCaps(cfg.recommended),warnings:[] } : null,
    hostHistory: hosts.map(h => ({ hostId:h.host_id,cpu:h.cpu,cores:h.cores,memGB:Number(h.mem_gb),seenAt:h.seen_at })),
    concurrency: { mode: cfg?.mode ?? settings?.mode ?? 'auto',caps:cfg ? wireCaps(cfg.caps) : { total:0,Claude:0,Codex:0,heavy:0 },memReserveGB:cfg?.memReserveGB ?? 4,
      limit:conc?.limit ?? null,used:{ total:totals.total,...totals.perAgent },subagentsObserved:observations.reduce((n,o)=>n+o.observed,0),subagentsHeld:observations.reduce((n,o)=>n+o.reserved,0),subRatio:0,
      heavyJobs:totals.heavy,resources:resources ? { ...resources,at:required(conc).created_at } : null,parallelWidth:width.width,startable:startable.length,factor:factor.factor,
      pressure:resources ? memoryPressure(resources.memFreeGB,resources.swapGB,cfg?.memReserveGB ?? 4) : false,conflictWaits:width.conflictWaits,
      adjustments:conc?.adjust ? [{ at:conc.created_at,...conc.adjust as object,by:'Runner' }] : [] },
    sessions:observations,unconfirmedHolds:holds.filter(h=>h.slot_state==='unconfirmed').map(h=>({ jobId:h.job,taskKey:tasks.find(t=>t.id===h.task)?.task_key ?? null,hostId:h.host_id,slots:h.slots })),
    observation:{ budget:cfg?.budget ?? { dev:0,qa:0 },profiles },
    usage:(await repo.allUsage()).map(u=>({ agent:u.agent,remainPct:Number(u.remain_pct),resetAt:u.reset_at,at:u.created_at })),
    gaps:sessions.filter(s=>s.ended_at).slice(-6).reverse().map(s=>({ from:s.ended_at,to:sessions.find(n=>n.started_at>required(s.ended_at))?.started_at ?? null,reason:s.end_reason ?? 'unknown' })),
    externalWrite:{ state:authority?.state ?? 'blocked',reason:authority?.blocked_reason ?? null },
  };
}
