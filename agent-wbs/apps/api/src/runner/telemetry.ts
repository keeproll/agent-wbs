import { OBSERVATION_GRADE, fromDb } from '@awbs/db';
import { heldSubagents, observationGrade, type ObservationKey } from '@awbs/shared';
import { PlatformError } from '../platform/errors.ts';
import { RunnerRepository } from './repository.ts';
import { caps, EXTERNAL_JOBS, wireCaps } from './service.ts';

type HostBody = Parameters<RunnerRepository['saveHost']>[0];
export async function reportHost(repo: RunnerRepository, body: HostBody) {
  await repo.lock();
  const authority = await repo.authority();
  const previous = await repo.host();
  const hostChanged = Boolean(authority && authority.host_id !== body.hostId);
  await repo.saveHost(body);
  await repo.setAuthority(body.hostId, hostChanged);
  if (hostChanged) await repo.alert(null, 'external-write-blocked', 'PC가 바뀌어 외부 쓰기를 차단했습니다. 이전 쓰기 중지 확인과 외부 상태 대조가 필요합니다.');
  if (hostChanged || previous && previous.boot_id !== body.bootId) {
    for (const hold of await repo.holds()) {
      if (hold.host_id !== previous?.host_id) continue;
      await repo.unconfirm(hold.job, hostChanged);
      if (hold.attempt) {
        const a = await repo.attempt(hold.attempt);
        if (a?.status === 'running') await repo.closeAttempt(a, 'interrupted', await repo.now(), { reason: hostChanged ? 'host_changed' : 'reboot' });
      }
      const job = await repo.job(hold.job);
      if (job && ['leased','started'].includes(job.state)) {
        await repo.state(job.id, EXTERNAL_JOBS.includes(job.kind) ? 'reconcile' : 'cancelled', { code: hostChanged ? 'HOST_CHANGED' : 'RUNNER_RESTARTED', message: hostChanged ? '실행 PC가 바뀌어 분석을 중단했습니다.' : '실행 PC가 재시작되어 분석을 중단했습니다.' });
        await repo.event(job, 'lease_lost', null, { hostChanged });
      }
    }
  }
  const config = await caps(repo);
  return { mode: config.mode, caps: wireCaps(config.caps), recommended: wireCaps(config.recommended), hostChanged };
}

type ConcurrencyBody = Parameters<RunnerRepository['saveConcurrency']>[1] & { at: string; sessions: { attemptId: string; observed: number; reserved: number; state: 'ok' | 'unconfirmed' }[] };
export async function reportConcurrency(repo: RunnerRepository, b: ConcurrencyBody) {
  if (b.running.Claude + b.running.Codex > 2147483647) throw new PlatformError('VALIDATION_FAILED', {}, [
    { path: 'running', rule: 'maximum', message: '동시 실행 수의 합은 2147483647 이하여야 합니다.' },
  ]);
  await repo.lock();
  const config = await caps(repo);
  if (b.limit > config.caps.total) throw new PlatformError('LIMIT_EXCEEDS_CAP');
  const registered = (await repo.observations()).map(r => ({ cli: r.cli, version: r.version, model: r.model, options: r.options, grade: fromDb(OBSERVATION_GRADE, r.grade) }));
  for (const [index, s] of b.sessions.entries()) {
    const a = await repo.attempt(s.attemptId);
    if (!a || a.status !== 'running') throw new PlatformError('ATTEMPT_CLOSED');
    const hold = await repo.hold(a.job);
    if (!hold || hold.host_id !== config.host.host_id || hold.closed_at) throw new PlatformError('INVALID_TRANSITION');
    const cli = await repo.observationConfig(a.agent);
    const conditions = cli ? cli.conditions as ObservationKey : { cli: a.agent, version: 'unknown', model: a.model_id, options: 'unknown' };
    const grade = observationGrade({ ...conditions, model: a.model_id }, registered);
    const prior = await repo.latestObservation(a.id);
    const state = prior?.state === 'unconfirmed' ? 'unconfirmed' : s.state;
    const reserved = heldSubagents({ grade, state, observed: s.observed, budget: config.budget[a.kind === 'dev' || a.kind === 'rework' ? 'dev' : 'qa'], previousHeld: prior?.reserved ?? Math.max(0, hold.slots - 1) });
    // 슬롯에는 실행 중인 세션 자신도 1개 더해 저장한다.
    if (hold.slot_state !== 'none' && reserved >= 2147483647) throw new PlatformError('VALIDATION_FAILED', {}, [
      { path: `sessions.${String(index)}.observed`, rule: 'maximum', message: '세션 자신을 포함한 슬롯 수는 2147483647 이하여야 합니다.' },
    ]);
    await repo.saveObservation(hold, a.agent, conditions.version, OBSERVATION_GRADE[grade], s.observed, reserved, state, b.at);
    // 화면의 「실제 실행 중 · 관측 N개」가 바뀌었을 때만 시도 변경을 알린다(리뷰 Codex 2). 같은 값의 반복 보고로 화면을 다시 읽게 하지 않는다.
    if (!prior || prior.observed !== s.observed || prior.state !== state) await repo.attemptChanged(a);
  }
  await repo.saveConcurrency(config.host.host_id, b);
  return { caps: { ...wireCaps(config.caps), memReserveGB: config.memReserveGB } };
}
